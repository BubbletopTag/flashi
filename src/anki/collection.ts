// SPDX-License-Identifier: AGPL-3.0-or-later
// A schema-11 Anki collection held in an in-memory SQLite database.
// Behaviour follows rslib (Copyright: Ankitects Pty Ltd and contributors);
// see the scheduler/ modules for the ported algorithms.

import defaults from "./defaults.json";
import { parseDeck, parseDeckConfig, writeDeckToday, compareDeckNames, type Deck, type DeckConfig, type Json } from "./config";
import { parseJson, stringifyJson } from "./json";
import { CardQueue, CardType, joinTags, splitTags, type Card, type Note, type RevlogEntry } from "./model";
import { applyAnswer, currentCardState, describeNextStates, fuzzSeed, nextStatesFor, stateForRating, type AnswerContext } from "./scheduler/answering";
import { buildDeckTree, type DeckTreeNode, type DueCounts } from "./scheduler/deckTree";
import { StudyQueue, type Counts, type QueueEntryKind } from "./scheduler/queue";
import { localMinutesWest, schedTimingToday, v1CreationDate, type SchedTimingToday } from "./scheduler/timing";
import { Db, num, str, type Row } from "./sqlite";
import type { SchedulingStates } from "./scheduler/states";
import { fsrsContext } from './scheduler/fsrs';

export const SCHEMA11_SQL = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL,
  ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL,
  models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL,
  usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL,
  flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL,
  mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL,
  ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL,
  odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL,
  ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

export const CARD_COLUMNS = "id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data";
export const NOTE_COLUMNS = "id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data";

export function rowToCard(r: Row): Card {
  return {
    id: num(r[0]), nid: num(r[1]), did: num(r[2]), ord: num(r[3]), mod: num(r[4]), usn: num(r[5]),
    type: num(r[6]), queue: num(r[7]), due: num(r[8]), ivl: num(r[9]), factor: num(r[10]), reps: num(r[11]),
    lapses: num(r[12]), left: num(r[13]), odue: num(r[14]), odid: num(r[15]), flags: num(r[16]), data: str(r[17]),
  };
}

export function cardToRow(c: Card): Array<number | string> {
  return [c.id, c.nid, c.did, c.ord, c.mod, c.usn, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.odue, c.odid, c.flags, c.data];
}

export function rowToNote(r: Row): Note {
  return {
    id: num(r[0]), guid: str(r[1]), mid: num(r[2]), mod: num(r[3]), usn: num(r[4]), tags: str(r[5]),
    flds: str(r[6]), sfld: typeof r[7] === "number" ? r[7] : str(r[7]), csum: num(r[8]), flags: num(r[9]), data: str(r[10]),
  };
}

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

interface UndoEntry {
  restore?: () => void;
  label: string;
  cards: Card[];
  revlogIds: number[];
  decks?: string;
  notes?: Array<{ id: number; tags: string; mod: number }>;
  requeue?: { id: number; kind: QueueEntryKind; deckId?: number };
}

export interface QueuedCard {
  card: Card;
  kind: QueueEntryKind;
  states: SchedulingStates;
  labels: string[];
  counts: Counts;
}

export class Collection {
  conf: Json = {};
  models: Record<string, Json> = {};
  decksJson: Record<string, Json> = {};
  dconf: Record<string, Json> = {};
  tagsJson: Record<string, number> = {};
  crt = 0;
  private jsonDirty = false;
  private queue: StudyQueue | null = null;
  private undoStack: UndoEntry[] = [];
  /** Bumped on every change, so storage can tell when to save. */
  changeCounter = 0;

  private constructor(readonly db: Db) {}

  static async create(now = nowSecs()): Promise<Collection> {
    const db = await Db.open();
    db.exec(SCHEMA11_SQL);
    const offset = localMinutesWest(now);
    const d = defaults as unknown as Json;
    const conf = { ...d.conf, creationOffset: offset, curDeck: 1, activeDecks: [1], nextPos: 1 };
    const keyed = (list: Json[]) => Object.fromEntries(list.map((x: Json) => [String(x.id), x]));
    db.exec("insert into col values (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)", [
      v1CreationDate(now, offset),
      now * 1000,
      now * 1000,
      stringifyJson(conf),
      stringifyJson(keyed(d.models)),
      stringifyJson(keyed(d.decks)),
      stringifyJson(keyed(d.dconf)),
      stringifyJson(d.tags ?? {}),
    ]);
    const col = new Collection(db);
    col.load();
    return col;
  }

  static async open(bytes: Uint8Array): Promise<Collection> {
    const db = await Db.open(bytes);
    const ver = num(db.scalar("select ver from col"));
    if (ver !== 11) throw new Error(`Unsupported collection schema ${ver}.`);
    const col = new Collection(db);
    col.load();
    return col;
  }

  private load(): void {
    const r = this.db.first("select crt, conf, models, decks, dconf, tags from col")!;
    this.crt = num(r[0]);
    this.conf = parseJson(str(r[1]) || "{}");
    this.models = parseJson(str(r[2]) || "{}");
    this.decksJson = parseJson(str(r[3]) || "{}");
    this.dconf = parseJson(str(r[4]) || "{}");
    this.tagsJson = parseJson(str(r[5]) || "{}");
  }

  markJsonDirty(): void {
    this.jsonDirty = true;
    this.changeCounter++;
  }

  private touch(): void {
    this.changeCounter++;
  }

  flush(): void {
    if (!this.jsonDirty) return;
    this.db.exec("update col set conf = ?, models = ?, decks = ?, dconf = ?, tags = ?, mod = ?", [
      stringifyJson(this.conf),
      stringifyJson(this.models),
      stringifyJson(this.decksJson),
      stringifyJson(this.dconf),
      stringifyJson(this.tagsJson),
      Date.now(),
    ]);
    this.jsonDirty = false;
  }

  serialize(): Uint8Array {
    this.flush();
    this.db.exec("drop table if exists temp.active_decks");
    return this.db.export();
  }

  // ------------------------------------------------------------ config

  configBool(key: string, fallback: boolean): boolean {
    const v = this.conf[key];
    return typeof v === "boolean" ? v : fallback;
  }

  setConf(key: string, value: unknown): void {
    this.conf[key] = value;
    this.markJsonDirty();
  }

  learnAheadSecs(): number {
    const v = this.conf.collapseTime;
    return typeof v === "number" ? v : 1200;
  }

  timing(now = nowSecs()): SchedTimingToday {
    const schedVer = typeof this.conf.schedVer === "number" ? this.conf.schedVer : 1;
    const rollover = schedVer >= 2 ? (typeof this.conf.rollover === "number" ? this.conf.rollover : 4) : null;
    const creationOffset = typeof this.conf.creationOffset === "number" ? this.conf.creationOffset : null;
    return schedTimingToday(this.crt, now, creationOffset, localMinutesWest(now), rollover);
  }

  // ------------------------------------------------------------ decks

  decksSorted(): Deck[] {
    return Object.values(this.decksJson)
      .map(parseDeck)
      .sort((a, b) => compareDeckNames(a.name, b.name));
  }

  deck(id: number): Deck | null {
    const raw = this.decksJson[String(id)];
    return raw ? parseDeck(raw) : null;
  }

  deckConfigs(): Map<number, DeckConfig> {
    const out = new Map<number, DeckConfig>();
    for (const raw of Object.values(this.dconf)) {
      const c = parseDeckConfig(raw);
      out.set(c.id, c);
    }
    return out;
  }

  /** The preset for a card's home deck (falls back to preset 1, then defaults). */
  configForDeck(did: number): DeckConfig {
    const deck = this.deck(did);
    const raw = (deck && this.dconf[String(deck.configId)]) ?? this.dconf["1"];
    return parseDeckConfig(raw ?? {});
  }

  deckByName(name: string): Deck | null {
    const key = name.toLowerCase();
    return this.decksSorted().find((d) => d.name.toLowerCase() === key) ?? null;
  }

  /** Create a normal deck (and any missing parents); returns its id. */
  addDeck(name: string, now = nowSecs()): number {
    const clean = name
      .split("::")
      .map((p) => p.trim())
      .filter(Boolean)
      .join("::");
    if (!clean) throw new Error("Enter a deck name.");
    const parts = clean.split("::");
    let id = 0;
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("::");
      const existing = this.deckByName(sub);
      if (existing) {
        id = existing.id;
        continue;
      }
      id = this.newDeckId();
      const template = (defaults as unknown as Json).decks.find((d: Json) => d.id === 1);
      this.decksJson[String(id)] = {
        ...structuredClone(template),
        id,
        name: sub,
        mod: now,
        usn: -1,
        conf: 1,
        collapsed: false,
        browserCollapsed: false,
      };
    }
    this.markJsonDirty();
    this.queue = null;
    return id;
  }

  private newDeckId(): number {
    let id = Date.now();
    while (this.decksJson[String(id)]) id++;
    return id;
  }

  setDeckCollapsed(did: number, collapsed: boolean): void {
    const raw = this.decksJson[String(did)];
    if (!raw) return;
    raw.collapsed = collapsed;
    this.markJsonDirty();
  }

  selectDeck(did: number): void {
    this.conf.curDeck = did;
    this.conf.activeDecks = [did];
    this.markJsonDirty();
  }

  currentDeckId(): number {
    const id = Number(this.conf.curDeck);
    return this.decksJson[String(id)] ? id : 1;
  }

  defaultDeckIsEmpty(): boolean {
    return !this.db.scalar("select 1 from cards where did = 1 or odid = 1 limit 1");
  }

  dueCounts(now: number): Map<number, DueCounts> {
    const timing = this.timing(now);
    const learnCutoff = now + this.learnAheadSecs();
    const out = new Map<number, DueCounts>();
    const rows = this.db.all(
      `select did, sum(queue = 0), sum(queue = 2 and due <= ?1), sum(queue = 3 and due <= ?1),
         sum((queue = 1 and due < ?2) or (queue = 4 and due <= ?2)), count(1)
       from cards group by did`,
      [timing.daysElapsed, learnCutoff],
    );
    for (const r of rows) {
      out.set(num(r[0]), {
        new: num(r[1]),
        review: num(r[2]),
        interdayLearning: num(r[3]),
        intradayLearning: num(r[4]),
        total: num(r[5]),
      });
    }
    return out;
  }

  deckTree(now = nowSecs()): DeckTreeNode {
    const timing = this.timing(now);
    this.unburyIfDayRolledOver(timing);
    return buildDeckTree(this.decksSorted(), this.deckConfigs(), this.dueCounts(now), timing.daysElapsed, {
      newCardsIgnoreReviewLimit: this.configBool("newCardsIgnoreReviewLimit", false),
      applyAllParentLimits: this.configBool("applyAllParentLimits", false),
      defaultDeckIsEmpty: this.defaultDeckIsEmpty(),
    });
  }

  private updateDeckStats(did: number, today: number, newDelta: number, reviewDelta: number, ms: number): void {
    const deck = this.deck(did);
    if (!deck) return;
    const parents = this.decksSorted().filter((d) => deck.name.startsWith(d.name + "::"));
    for (const d of [deck, ...parents]) {
      const raw = this.decksJson[String(d.id)];
      if (!raw) continue;
      if (d.lastDayStudied !== today) {
        d.newStudied = 0;
        d.reviewStudied = 0;
        d.learningStudied = 0;
        d.millisecondsStudied = 0;
        d.lastDayStudied = today;
      }
      d.newStudied += newDelta;
      d.reviewStudied += reviewDelta;
      d.millisecondsStudied += ms;
      writeDeckToday(raw, d);
    }
    this.markJsonDirty();
  }

  // ------------------------------------------------------------ cards & notes

  getCard(id: number): Card | null {
    const r = this.db.first(`select ${CARD_COLUMNS} from cards where id = ?`, [id]);
    return r ? rowToCard(r) : null;
  }

  updateCard(card: Card): void {
    this.db.exec(
      `update cards set nid=?2, did=?3, ord=?4, mod=?5, usn=?6, type=?7, queue=?8, due=?9, ivl=?10, factor=?11, reps=?12,
        lapses=?13, left=?14, odue=?15, odid=?16, flags=?17, data=?18 where id=?1`,
      cardToRow(card),
    );
    this.touch();
  }

  getNote(id: number): Note | null {
    const r = this.db.first(`select ${NOTE_COLUMNS} from notes where id = ?`, [id]);
    return r ? rowToNote(r) : null;
  }

  model(mid: number): Json | null {
    return this.models[String(mid)] ?? null;
  }

  cardCount(): number {
    return num(this.db.scalar("select count(*) from cards"));
  }

  noteCount(): number {
    return num(this.db.scalar("select count(*) from notes"));
  }

  private addTagToNote(nid: number, tag: string, now: number): { id: number; tags: string; mod: number } | null {
    const note = this.getNote(nid);
    if (!note) return null;
    const tags = splitTags(note.tags);
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return null;
    const before = { id: note.id, tags: note.tags, mod: note.mod };
    tags.push(tag);
    this.db.exec("update notes set tags = ?, mod = ?, usn = -1 where id = ?", [joinTags(tags), now, nid]);
    if (!(tag in this.tagsJson)) {
      this.tagsJson[tag] = -1;
      this.markJsonDirty();
    }
    return before;
  }

  // ------------------------------------------------------------ studying

  unburyIfDayRolledOver(timing: SchedTimingToday): void {
    const last = typeof this.conf.lastUnburied === "number" ? this.conf.lastUnburied : 0;
    const today = timing.daysElapsed;
    if (last < today || today + 7 < last) {
      this.db.exec(
        `update cards set queue = case
            when type in (1, 3) then (case when due > 1000000000 then 1 else 3 end)
            when type = 0 then 0 else 2 end
          where queue in (-2, -3)`,
      );
      this.setConf("lastUnburied", today);
    }
  }

  private answerContext(card: Card, timing: SchedTimingToday, now: number): AnswerContext {
    const homeDid = card.odid || card.did;
    const config = this.configForDeck(homeDid);
    const q = this.queue;
    const seed = fuzzSeed(card.id, card.reps);
    const dcid = q?.didToDcid.get(homeDid);
    const loadBalancer =
      q?.loadBalancer && dcid !== undefined
        ? {
            findInterval: (interval: number, min: number, max: number) =>
              q.loadBalancer!.findInterval(interval, min, max, dcid, seed, config.buryReviews ? card.nid : null),
          }
        : null;
    return { config, timing, now, loadBalancer, fsrs: fsrsContext(this,card,timing.nextDayAt) };
  }

  /** The study queue for `deckId`, rebuilt when stale. */
  studyQueue(deckId: number, now = nowSecs()): StudyQueue {
    const timing = this.timing(now);
    if (!this.queue || this.queue.deckId !== deckId || this.queue.currentDay !== timing.daysElapsed) {
      this.unburyIfDayRolledOver(timing);
      this.queue = StudyQueue.build(this, deckId, timing, this.learnAheadSecs());
    }
    return this.queue;
  }

  invalidateQueue(): void {
    this.queue = null;
  }

  /** The next card to study in `deckId`, with its answer states and labels. */
  nextCard(deckId: number, now = nowSecs()): QueuedCard | null {
    const queue = this.studyQueue(deckId, now);
    const counts = queue.getCounts(now);
    const next = queue.next();
    if (!next) return null;
    const card = this.getCard(next.id);
    if (!card) {
      this.queue = null;
      return this.nextCard(deckId, now);
    }
    const timing = this.timing(now);
    const ctx = this.answerContext(card, timing, now);
    const states = nextStatesFor(card, ctx);
    return { card, kind: next.kind, states, labels: describeNextStates(states, ctx, this.learnAheadSecs()), counts };
  }

  /** Answer a card shown by `nextCard`. */
  answerCard(cardId: number, rating: number, millisecondsTaken: number, nowMs = Date.now()): Card {
    const now = Math.floor(nowMs / 1000);
    const original = this.getCard(cardId);
    if (!original) throw new Error("That card no longer exists.");
    const timing = this.timing(now);
    const ctx = this.answerContext(original, timing, now);
    const current = currentCardState(original, ctx);
    const states = nextStatesFor(original, ctx);
    const next = stateForRating(states, rating);
    const decksBefore = stringifyJson(this.decksJson);
    let revlogId = nowMs;
    while (this.db.scalar("select 1 from revlog where id = ?", [revlogId])) revlogId++;
    const result = applyAnswer(original, current, next, rating, revlogId, millisecondsTaken, ctx);
    const entry: UndoEntry = { label: "Answer card", cards: [original], revlogIds: [revlogId], decks: decksBefore };
    this.db.transaction(() => {
      this.updateCard(result.card);
      this.addRevlog(result.revlog);
      const newDelta = original.queue === CardQueue.New ? 1 : 0;
      const reviewDelta = original.queue === CardQueue.Review || original.queue === CardQueue.DayLearn ? 1 : 0;
      this.updateDeckStats(original.did, timing.daysElapsed, newDelta, reviewDelta, result.revlog.time);
      if (result.leeched) {
        const before = this.addTagToNote(original.nid, "leech", now);
        if (before) entry.notes = [before];
      }
      this.burySiblingsAfterAnswer(original, ctx.config, entry);
    });
    const queue = this.queue;
    if (queue) {
      const head = queue.next();
      entry.requeue = { id: original.id, kind: head && head.id === original.id ? head.kind : kindForCard(original) };
      queue.afterAnswer(result.card, timing, now);
    }
    this.pushUndo(entry);
    return result.card;
  }

  /** rslib scheduler/congrats.rs: what's left in `deckId` once studying is done. */
  congratsInfo(deckId: number, now = nowSecs()): {
    learnRemaining: number;
    secsUntilNextLearn: number;
    reviewRemaining: boolean;
    newRemaining: boolean;
    haveBuried: boolean;
  } {
    const today = this.timing(now).daysElapsed;
    const root = this.deck(deckId);
    const ids = this.decksSorted()
      .filter((d) => root && (d.id === root.id || d.name.startsWith(root.name + "::")))
      .map((d) => d.id);
    const list = ids.length ? ids.join(",") : "-1";
    const r = this.db.first(
      `select
        coalesce(sum(queue in (2, 3) and due <= ?), 0),
        coalesce(sum(queue = 0), 0),
        coalesce(sum(queue in (-2, -3)), 0),
        coalesce(sum(queue = 1), 0),
        max(0, coalesce(min(case when queue = 1 then due else null end), 0))
      from cards where did in (${list})`,
      [today],
    );
    const nextLearnDue = num(r?.[4]);
    return {
      learnRemaining: num(r?.[3]),
      secsUntilNextLearn: nextLearnDue === 0 ? 86_400 : Math.max(nextLearnDue - this.learnAheadSecs() - now, 60),
      reviewRemaining: num(r?.[0]) > 0,
      newRemaining: num(r?.[1]) > 0,
      haveBuried: num(r?.[2]) > 0,
    };
  }

  /** Restore buried cards in a deck and its subdecks. */
  unburyDeck(deckId: number): void {
    const root = this.deck(deckId);
    if (!root) return;
    const ids = this.decksSorted()
      .filter((d) => d.id === root.id || d.name.startsWith(root.name + "::"))
      .map((d) => d.id);
    this.db.exec(
      `update cards set queue = case
          when type in (1, 3) then (case when due > 1000000000 then 1 else 3 end)
          when type = 0 then 0 else 2 end, mod = ?, usn = -1
        where queue in (-2, -3) and did in (${ids.join(",")})`,
      [nowSecs()],
    );
    this.queue = null;
    this.touch();
  }

  private burySiblingsAfterAnswer(card: Card, config: DeckConfig, entry: UndoEntry): void {
    if (!config.buryNew && !config.buryReviews && !config.buryInterdayLearning) return;
    const siblings = this.db
      .all(`select ${CARD_COLUMNS} from cards where nid = ? and id != ?`, [card.nid, card.id])
      .map(rowToCard)
      .filter(
        (c) =>
          (config.buryNew && c.queue === CardQueue.New) ||
          (config.buryReviews && c.queue === CardQueue.Review) ||
          (config.buryInterdayLearning && (c.queue === CardQueue.DayLearn || c.queue === CardQueue.Learn)),
      );
    for (const sibling of siblings) {
      entry.cards.push(sibling);
      this.updateCard({ ...sibling, queue: CardQueue.SchedBuried, mod: nowSecs(), usn: -1 });
    }
    if (siblings.length) this.queue = null;
  }

  addRevlog(r: RevlogEntry): void {
    this.db.exec("insert into revlog values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      r.id, r.cid, r.usn, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type,
    ]);
    this.touch();
  }

  buryCard(cardId: number): void {
    this.setQueueFor(cardId, CardQueue.UserBuried, "Bury card");
  }

  suspendCard(cardId: number): void {
    this.setQueueFor(cardId, CardQueue.Suspended, "Suspend card");
  }

  buryNote(cardId: number): void {
    const card = this.getCard(cardId);
    if (!card) return;
    const cards = this.db.all(`select ${CARD_COLUMNS} from cards where nid = ?`, [card.nid]).map(rowToCard);
    this.changeQueues(cards, CardQueue.UserBuried, "Bury note", cardId);
  }

  suspendNote(cardId: number): void {
    const card = this.getCard(cardId);
    if (!card) return;
    const cards = this.db.all(`select ${CARD_COLUMNS} from cards where nid = ?`, [card.nid]).map(rowToCard);
    this.changeQueues(cards, CardQueue.Suspended, "Suspend note", cardId);
  }

  private setQueueFor(cardId: number, queue: number, label: string): void {
    const card = this.getCard(cardId);
    if (card) this.changeQueues([card], queue, label);
  }

  private changeQueues(cards: Card[], queue: number, label: string, focusId = cards[0]?.id): void {
    const now = nowSecs();
    const changed = cards.filter((c) => c.queue !== queue && c.queue !== CardQueue.Suspended);
    if (!changed.length) return;
    this.db.transaction(() => {
      for (const c of changed) this.updateCard({ ...c, queue, mod: now, usn: -1 });
    });
    const focus = changed.find((card) => card.id === focusId);
    this.pushUndo({ label, cards: changed, revlogIds: [], requeue: focus && this.queue ? { id: focus.id, kind: kindForCard(focus), deckId: this.queue.deckId } : undefined });
    this.queue = null;
  }

  /** Flags 0 (none) – 7 (purple), as stored in the low 3 bits of `cards.flags`. */
  setFlag(cardId: number, flag: number): void {
    const card = this.getCard(cardId);
    if (!card) return;
    this.pushUndo({ label: "Set flag", cards: [card], revlogIds: [] });
    this.updateCard({ ...card, flags: (card.flags & ~0b111) | (flag & 0b111), mod: nowSecs(), usn: -1 });
    if (this.queue) {
      for (const e of this.queue.main) if (e.id === cardId) e.mtime = nowSecs();
    }
  }

  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  canUndo(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  registerUndo(label: string, restore: () => void): void {
    this.pushUndo({ label, cards: [], revlogIds: [], restore });
  }

  /** Undo the last study action; returns the label, or null if nothing to undo. */
  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.db.transaction(() => {
      entry.restore?.();
      for (const c of entry.cards) this.updateCard(c);
      for (const id of entry.revlogIds) this.db.exec("delete from revlog where id = ?", [id]);
      for (const n of entry.notes ?? []) this.db.exec("update notes set tags = ?, mod = ? where id = ?", [n.tags, n.mod, n.id]);
    });
    if (entry.decks) {
      this.decksJson = parseJson(entry.decks);
      this.markJsonDirty();
    }
    const deckId = entry.requeue?.deckId ?? this.queue?.deckId;
    this.queue = null;
    if (entry.requeue && deckId !== undefined) {
      const q = this.studyQueue(deckId);
      const card = entry.cards.find((card) => card.id === entry.requeue!.id)!;
      q.pushFront(card.id, card.mod, entry.requeue.kind, card.due, card.reps);
    }
    this.touch();
    return entry.label;
  }
}

function kindForCard(card: Card): QueueEntryKind {
  if (card.queue === CardQueue.New) return "new";
  if (card.queue === CardQueue.Review) return "review";
  if (card.queue === CardQueue.DayLearn) return "interdayLearning";
  return "learning";
}

export { CardType };
