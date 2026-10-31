// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/scheduler/queue/** (Copyright: Ankitects Pty Ltd and contributors):
// gathering with per-deck limits, sibling burying, sorting, review/new
// interleaving, the intraday learning queue and learn-ahead handling.

import type { Deck, DeckConfig } from "../config";
import { compareDeckNames } from "../config";
import { CardQueue, type Card } from "../model";
import type { Db } from "../sqlite";
import { num } from "../sqlite";
import { fnvHashI64 } from "../rng";
import { LimitTreeMap } from "./limits";
import { LOAD_BALANCE_DAYS, LoadBalancer } from "./loadBalancer";
import type { SchedTimingToday } from "./timing";

export type MainKind = "new" | "review" | "interdayLearning";

export interface MainEntry {
  id: number;
  mtime: number;
  kind: MainKind;
}

export interface LearningEntry {
  due: number;
  id: number;
  mtime: number;
  reps: number;
}

export interface Counts {
  new: number;
  learning: number;
  review: number;
}

export type QueueEntryKind = MainKind | "learning";

export interface QueueSource {
  db: Db;
  decksSorted(): Deck[];
  deckConfigs(): Map<number, DeckConfig>;
  configBool(key: string, fallback: boolean): boolean;
}

interface BuryMode {
  buryNew: boolean;
  buryReviews: boolean;
  buryInterdayLearning: boolean;
}

interface DueCard {
  id: number;
  nid: number;
  mtime: number;
  due: number;
  did: number;
  odid: number;
  reps: number;
  kind: "review" | "learning";
}

interface NewCard {
  id: number;
  nid: number;
  mtime: number;
  did: number;
  odid: number;
  ord: number;
  hash: bigint;
}

function cmpRepsThenDue(a: LearningEntry, b: LearningEntry): number {
  const ka = a.reps === 0 ? 1 : 0;
  const kb = b.reps === 0 ? 1 : 0;
  if (ka !== kb) return ka - kb;
  return a.due - b.due;
}

/** `Intersperser`: spread `two` evenly through `one`. */
function intersperse<T>(one: T[], two: T[]): T[] {
  const out: T[] = [];
  const ratio = Math.fround((one.length + 1) / (two.length + 1));
  let i1 = 0;
  let i2 = 0;
  while (i1 < one.length || i2 < two.length) {
    if (i1 < one.length && i2 < two.length) {
      const relative2 = Math.fround((i2 + 1) * ratio);
      if (relative2 < i1 + 1) out.push(two[i2++]!);
      else out.push(one[i1++]!);
    } else if (i1 < one.length) out.push(one[i1++]!);
    else out.push(two[i2++]!);
  }
  return out;
}

function mix<T>(reviews: T[], other: T[], mode: number, otherIsNew: boolean): T[] {
  // ReviewMix: 0 = mix, 1 = after reviews, 2 = before reviews
  if (mode === 1) return [...reviews, ...other];
  if (mode === 2) return [...other, ...reviews];
  void otherIsNew;
  return intersperse(reviews, other);
}

function reviewOrderSql(order: number, today: number): string {
  const deck = "(select rowid from active_decks ad where ad.id = did)";
  const parts: string[] = (() => {
    switch (order) {
      case 1: return ["due", deck];
      case 2: return [deck, "due"];
      case 3: return ["ivl asc"];
      case 4: return ["ivl desc"];
      case 5: return ["factor asc"];
      case 6: return ["factor desc"];
      case 12: return [`-(1 + cast(${today}-due+0.001 as real)/ivl) asc`];
      case 8: return [];
      case 9: return ["nid asc, ord asc"];
      case 10: return ["nid desc, ord asc"];
      default: return ["due"]; // Day; FSRS retrievability orders fall back to it
    }
  })();
  parts.push("fnvhash(id, mod)");
  return parts.join(", ");
}

function newSortSql(gather: number, salt: number): string {
  switch (gather) {
    case 2: return "due DESC, ord ASC";
    case 3:
    case 5: return `fnvhash(nid, ${salt}), ord ASC`;
    case 4: return `fnvhash(id, ${salt})`;
    default: return "due ASC, ord ASC";
  }
}

export class StudyQueue {
  counts: Counts = { new: 0, learning: 0, review: 0 };
  main: MainEntry[] = [];
  intradayLearning: LearningEntry[] = [];
  currentLearningCutoff = 0;

  private constructor(
    readonly deckId: number,
    readonly currentDay: number,
    readonly learnAheadSecs: number,
    readonly loadBalancer: LoadBalancer | null,
    readonly didToDcid: Map<number, number>,
  ) {}

  static build(src: QueueSource, deckId: number, timing: SchedTimingToday, learnAheadSecs: number): StudyQueue {
    const db = src.db;
    const today = timing.daysElapsed;
    const configs = src.deckConfigs();
    const allDecks = src.decksSorted();
    const root = allDecks.find((d) => d.id === deckId) ?? allDecks.find((d) => d.id === 1) ?? allDecks[0]!;
    const prefix = root.name + "::";
    const active = allDecks.filter((d) => d.id === root.id || d.name.startsWith(prefix));
    const limitDecks = [...active];
    if (src.configBool("applyAllParentLimits", false)) {
      const parents = allDecks.filter((d) => root.name.startsWith(d.name + "::"));
      limitDecks.unshift(...parents);
    }
    const limits = new LimitTreeMap(limitDecks, configs, today, src.configBool("newCardsIgnoreReviewLimit", false));
    const rootConfig = root.filtered ? undefined : configs.get(root.configId);
    const sort = {
      newOrder: rootConfig ? rootConfig.newSortOrder : 1,
      gather: rootConfig?.newGatherPriority ?? 0,
      reviewOrder: rootConfig?.reviewOrder ?? 0,
      dayLearnMix: rootConfig?.interdayLearningMix ?? 0,
      newMix: rootConfig?.newMix ?? 0,
    };

    db.exec("drop table if exists temp.active_decks");
    db.exec("create temporary table active_decks (id integer not null unique)");
    for (const d of active) db.exec("insert into active_decks (id) values (?)", [d.id]);

    const didToDcid = new Map<number, number>();
    for (const d of allDecks) if (!d.filtered) didToDcid.set(d.id, d.configId);

    let loadBalancer: LoadBalancer | null = null;
    if (src.configBool("loadBalancerEnabled", true)) {
      const rows = db
        .all("select id, nid, did, due from cards where due >= ? and due < ?", [today, today + LOAD_BALANCE_DAYS])
        .map((r) => ({ cid: num(r[0]), nid: num(r[1]), did: num(r[2]), due: num(r[3]) }));
      const easyDays = new Map<number, number[]>();
      for (const [id, c] of configs) easyDays.set(id, c.easyDaysPercentages);
      loadBalancer = new LoadBalancer(today, rows, didToDcid, easyDays, timing.nextDayAt);
    }

    const q = new StudyQueue(root.id, today, learnAheadSecs, loadBalancer, didToDcid);
    const seenNotes = new Map<number, BuryMode>();
    const deckById = new Map(allDecks.map((d) => [d.id, d]));
    const buryModeFor = (did: number): BuryMode => {
      const deck = deckById.get(did);
      const c = deck && !deck.filtered ? configs.get(deck.configId) : undefined;
      return {
        buryNew: c?.buryNew ?? false,
        buryReviews: c?.buryReviews ?? false,
        buryInterdayLearning: c?.buryInterdayLearning ?? false,
      };
    };
    const getAndUpdateBuryMode = (nid: number, did: number, odid: number): BuryMode | null => {
      const mode = buryModeFor(odid || did);
      const previous = seenNotes.get(nid);
      if (previous) {
        seenNotes.set(nid, {
          buryNew: previous.buryNew || mode.buryNew,
          buryReviews: previous.buryReviews || mode.buryReviews,
          buryInterdayLearning: previous.buryInterdayLearning || mode.buryInterdayLearning,
        });
        return previous;
      }
      seenNotes.set(nid, mode);
      return null;
    };

    // intraday learning
    const learning: DueCard[] = [];
    db.each(
      "select id, nid, due, cast(mod as integer), did, odid, reps from cards where did in (select id from active_decks) and queue in (1, 4) and due <= ?",
      [timing.nextDayAt],
      (r) => {
        const card: DueCard = {
          id: num(r[0]), nid: num(r[1]), due: num(r[2]), mtime: num(r[3]), did: num(r[4]), odid: num(r[5]),
          reps: num(r[6]), kind: "learning",
        };
        getAndUpdateBuryMode(card.nid, card.did, card.odid);
        learning.push(card);
      },
    );

    // interday learning, then reviews
    const dayLearning: DueCard[] = [];
    const reviews: DueCard[] = [];
    for (const kind of ["learning", "review"] as const) {
      if (limits.rootLimitReached("review")) continue;
      const queue = kind === "review" ? CardQueue.Review : CardQueue.DayLearn;
      db.each(
        `select id, nid, due, cast(ivl as integer), cast(mod as integer), did, odid, reps from cards where did in (select id from active_decks) and (queue = ? and due <= ?) order by ${reviewOrderSql(sort.reviewOrder, today)}`,
        [queue, today],
        (r) => {
          if (limits.rootLimitReached("review")) return false;
          const card: DueCard = {
            id: num(r[0]), nid: num(r[1]), due: num(r[2]), mtime: num(r[4]), did: num(r[5]), odid: num(r[6]),
            reps: num(r[7]), kind,
          };
          if (!limits.limitReached(card.did, "review")) {
            const prev = getAndUpdateBuryMode(card.nid, card.did, card.odid);
            const bury = prev ? (kind === "review" ? prev.buryReviews : prev.buryInterdayLearning) : false;
            if (!bury) {
              (kind === "review" ? reviews : dayLearning).push(card);
              limits.decrementDeckAndParentLimits(card.did, "review");
            }
          }
          return true;
        },
      );
    }

    // new cards
    const fresh: NewCard[] = [];
    const salt = Math.imul(today, 2654435761) >>> 0;
    const toNew = (r: ReturnType<Db["all"]>[number]): NewCard => ({
      id: num(r[0]), nid: num(r[1]), ord: num(r[2]), mtime: num(r[3]), did: num(r[4]), odid: num(r[5]), hash: 0n,
    });
    const addNew = (card: NewCard): boolean => {
      const prev = getAndUpdateBuryMode(card.nid, card.did, card.odid);
      if (prev?.buryNew) return false;
      fresh.push(card);
      return true;
    };
    const order = newSortSql(sort.gather, salt);
    if (sort.gather === 0 || sort.gather === 5) {
      const deckIds = [...active].sort((a, b) => compareDeckNames(a.name, b.name)).map((d) => d.id);
      for (const did of deckIds) {
        if (limits.rootLimitReached("new")) break;
        if (limits.limitReached(did, "new")) continue;
        db.each(
          `select id, nid, ord, cast(mod as integer), did, odid from cards where did = ? and queue = 0 order by ${order}`,
          [did],
          (r) => {
            const reached = limits.limitReached(did, "new");
            if (!reached && addNew(toNew(r))) limits.decrementDeckAndParentLimits(did, "new");
            return !reached;
          },
        );
      }
    } else {
      db.each(
        `select id, nid, ord, cast(mod as integer), did, odid from cards where did in (select id from active_decks) and queue = 0 order by ${order}`,
        undefined,
        (r) => {
          if (limits.rootLimitReached("new")) return false;
          const card = toNew(r);
          if (!limits.limitReached(card.did, "new") && addNew(card)) {
            limits.decrementDeckAndParentLimits(card.did, "new");
          }
          return true;
        },
      );
    }

    // sort new cards
    const hashWith = (v: number) => BigInt.asUintN(64, fnvHashI64(v, today));
    switch (sort.newOrder) {
      case 0:
        stableSortBy(fresh, (a, b) => a.ord - b.ord);
        break;
      case 2:
        for (const c of fresh) c.hash = hashWith(c.id);
        fresh.sort((a, b) => a.ord - b.ord || cmpBig(a.hash, b.hash));
        break;
      case 3:
        for (const c of fresh) c.hash = hashWith(c.nid);
        fresh.sort((a, b) => cmpBig(a.hash, b.hash) || a.ord - b.ord);
        break;
      case 4:
        for (const c of fresh) c.hash = hashWith(c.id);
        fresh.sort((a, b) => cmpBig(a.hash, b.hash));
        break;
    }

    q.intradayLearning = learning
      .map((c) => ({ due: c.due, id: c.id, mtime: c.mtime, reps: c.reps }))
      .sort(cmpRepsThenDue);
    const now = timing.now;
    const cutoff = now + learnAheadSecs;
    q.counts = {
      new: fresh.length,
      review: reviews.length,
      learning: q.intradayLearning.filter((e) => e.due <= cutoff).length + dayLearning.length,
    };
    const toMain = (kind: MainKind) => (c: { id: number; mtime: number }): MainEntry => ({ id: c.id, mtime: c.mtime, kind });
    const withInterday = mix(reviews.map(toMain("review")), dayLearning.map(toMain("interdayLearning")), sort.dayLearnMix, false);
    q.main = mix(withInterday, fresh.map(toMain("new")), sort.newMix, true);
    q.currentLearningCutoff = now;
    return q;
  }

  private aheadCutoff(): number {
    return this.currentLearningCutoff + this.learnAheadSecs;
  }

  /** Next card to show, in the same order as Anki's `get_queued_cards`. */
  next(): { id: number; kind: QueueEntryKind } | null {
    const nowEntry = this.intradayLearning.find((e) => e.due <= this.currentLearningCutoff);
    if (nowEntry) return { id: nowEntry.id, kind: "learning" };
    const head = this.main[0];
    if (head) return { id: head.id, kind: head.kind };
    const ahead = this.intradayLearning.find((e) => e.due > this.currentLearningCutoff && e.due <= this.aheadCutoff());
    if (ahead) return { id: ahead.id, kind: "learning" };
    return null;
  }

  /** Counts, refreshing the learn-ahead window if nothing is left. */
  getCounts(now: number): Counts {
    if (this.counts.new === 0 && this.counts.learning === 0 && this.counts.review === 0) {
      this.updateLearningCutoffAndCount(now);
    }
    return { ...this.counts };
  }

  updateLearningCutoffAndCount(now: number): void {
    const lastAhead = this.aheadCutoff();
    this.currentLearningCutoff = now;
    const newAhead = this.aheadCutoff();
    this.counts.learning += this.intradayLearning.filter((e) => e.due > lastAhead && e.due <= newAhead).length;
  }

  /** Bookkeeping after `card` (already updated) was answered from the queue. */
  afterAnswer(card: Card, timing: SchedTimingToday, now: number): void {
    const idx = this.intradayLearning.findIndex((e) => e.id === card.id);
    if (idx >= 0) {
      this.intradayLearning.splice(idx, 1);
      this.counts.learning = Math.max(this.counts.learning - 1, 0);
    } else if (this.main[0]?.id === card.id) {
      const head = this.main.shift()!;
      if (head.kind === "new") this.counts.new--;
      else if (head.kind === "review") this.counts.review--;
      else this.counts.learning = Math.max(this.counts.learning - 1, 0);
    }
    const intraday = card.queue === CardQueue.Learn || card.queue === CardQueue.PreviewRepeat;
    if (intraday && card.due < timing.nextDayAt) {
      const entry: LearningEntry = { due: card.due, id: card.id, mtime: card.mod, reps: card.reps };
      const cutoff = this.aheadCutoff();
      if (entry.due <= cutoff && this.main.length === 0) {
        const front = this.intradayLearning[0];
        if (front && front.due >= entry.due && front.due + 1 < cutoff) entry.due = front.due + 1;
      }
      if (entry.due <= this.aheadCutoff()) this.counts.learning++;
      let pos = 0;
      while (pos < this.intradayLearning.length && cmpRepsThenDue(this.intradayLearning[pos]!, entry) < 0) pos++;
      this.intradayLearning.splice(pos, 0, entry);
    }
    if (card.queue === CardQueue.Review && this.loadBalancer) {
      const dcid = this.didToDcid.get(card.odid || card.did);
      if (dcid !== undefined) this.loadBalancer.addCard(card.id, card.nid, dcid, card.ivl);
    }
    this.updateLearningCutoffAndCount(now);
  }

  /** Put an entry back at the front (used after undo). */
  pushFront(id: number, mtime: number, kind: QueueEntryKind, due: number, reps: number): void {
    this.intradayLearning = this.intradayLearning.filter((e) => e.id !== id);
    this.main = this.main.filter((e) => e.id !== id);
    if (kind === "learning") {
      this.intradayLearning.unshift({ id, mtime, due, reps });
      this.counts.learning++;
    } else {
      this.main.unshift({ id, mtime, kind });
      if (kind === "new") this.counts.new++;
      else if (kind === "review") this.counts.review++;
      else this.counts.learning++;
    }
  }
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableSortBy<T>(arr: T[], cmp: (a: T, b: T) => number): void {
  const indexed = arr.map((v, i) => [v, i] as const);
  indexed.sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
  indexed.forEach(([v], i) => (arr[i] = v));
}
