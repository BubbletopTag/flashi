// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/scheduler/states/load_balancer.rs
// (Copyright: Ankitects Pty Ltd and contributors).

import { ChaCha12Rng, f32, weightedIndexSampleF32 } from "../rng";
import { constrainedFuzzBounds } from "./states";

const MAX_LOAD_BALANCE_INTERVAL = 90;
export const LOAD_BALANCE_DAYS = Math.trunc(f32(MAX_LOAD_BALANCE_INTERVAL * f32(1.1)));

const SIBLING_MODIFIER_STEPS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
const SIBLING_MODIFIER_RANGE = [1.0, 0.8, 0.6, 0.4, 0.2, 0.000001, 0.2, 0.4, 0.6, 0.8, 1.0].map(f32);

type EasyDay = "minimum" | "reduced" | "normal";

function easyDayFrom(v: number): EasyDay {
  const x = f32(v);
  if (x === 1) return "normal";
  if (x === 0) return "minimum";
  return "reduced";
}

function loadModifier(day: EasyDay): number {
  return day === "minimum" ? f32(0.0001) : day === "reduced" ? f32(0.5) : 1;
}

interface LoadBalancerDay {
  cards: Array<{ cid: number; nid: number }>;
  notes: Map<number, number>;
}

function newDay(): LoadBalancerDay {
  return { cards: [], notes: new Map() };
}

function addToDay(day: LoadBalancerDay, cid: number, nid: number): void {
  day.cards.push({ cid, nid });
  day.notes.set(nid, (day.notes.get(nid) ?? 0) + 1);
}

export interface DueCardRow {
  cid: number;
  nid: number;
  did: number;
  due: number;
}

export class LoadBalancer {
  private readonly daysByPreset = new Map<number, LoadBalancerDay[]>();
  private readonly easyDaysByPreset = new Map<number, EasyDay[]>();

  /**
   * @param rows cards with `today <= due < today + LOAD_BALANCE_DAYS` (any queue,
   *   matching Anki's `get_all_cards_due_in_range`)
   */
  constructor(
    today: number,
    rows: readonly DueCardRow[],
    didToDcid: ReadonlyMap<number, number>,
    easyDaysByPreset: ReadonlyMap<number, readonly number[]>,
    private readonly nextDayAt: number,
  ) {
    for (const row of rows) {
      const dcid = didToDcid.get(row.did);
      if (dcid === undefined) continue;
      let days = this.daysByPreset.get(dcid);
      if (!days) {
        days = Array.from({ length: LOAD_BALANCE_DAYS }, newDay);
        this.daysByPreset.set(dcid, days);
      }
      const idx = row.due - today;
      if (idx >= 0 && idx < LOAD_BALANCE_DAYS) addToDay(days[idx]!, row.cid, row.nid);
    }
    for (const [dcid, percentages] of easyDaysByPreset) {
      this.easyDaysByPreset.set(
        dcid,
        percentages.length === 7 ? percentages.map(easyDayFrom) : Array<EasyDay>(7).fill("normal"),
      );
    }
  }

  findInterval(
    interval: number,
    minimum: number,
    maximum: number,
    dcid: number,
    fuzzSeed: bigint | null,
    noteId: number | null,
  ): number | null {
    if (Math.trunc(interval) > MAX_LOAD_BALANCE_INTERVAL || minimum > MAX_LOAD_BALANCE_INTERVAL) return null;
    const [before, after] = constrainedFuzzBounds(interval, minimum, maximum);
    const days = this.daysByPreset.get(dcid);
    if (!days) return null;
    const easyDays = this.easyDaysByPreset.get(dcid);
    if (!easyDays) return null;
    const reviewCounts: number[] = [];
    const weekdays: number[] = [];
    for (let i = before; i <= after; i++) {
      reviewCounts.push(days[i]!.cards.length);
      weekdays.push(intervalToWeekday(i, this.nextDayAt));
    }
    const easyMods = calculateEasyDaysModifiers(easyDays, weekdays, reviewCounts);
    const siblingMods = this.calculateSiblingModifiers(before, after, noteId);
    const weights = reviewCounts.map((count, i) => {
      if (count === 0) return 1;
      const target = i + before;
      const countWeight = f32(Math.pow(f32(1 / count), f32(2.15)));
      const base = f32(1 / target);
      const intervalWeight = f32(f32(base * base) * base);
      return f32(f32(f32(countWeight * intervalWeight) * siblingMods[i]!) * easyMods[i]!);
    });
    if (fuzzSeed === null) return null;
    const idx = weightedIndexSampleF32(ChaCha12Rng.seedFromU64(fuzzSeed), weights);
    return idx === null ? null : idx + before;
  }

  /** Called after answering a card that ends up in the review queue. */
  addCard(cid: number, nid: number, dcid: number, interval: number): void {
    const day = this.daysByPreset.get(dcid)?.[interval];
    if (day) addToDay(day, cid, nid);
  }

  private calculateSiblingModifiers(before: number, after: number, nid: number | null): number[] {
    const modifiers = Array<number>(after - before + 1).fill(1);
    if (nid === null) return modifiers;
    const siblingDays = new Set<number>();
    for (const days of this.daysByPreset.values()) {
      days.forEach((day, i) => {
        if (day.notes.has(nid)) siblingDays.add(i);
      });
    }
    for (const siblingDay of siblingDays) {
      SIBLING_MODIFIER_STEPS.forEach((step, k) => {
        const target = siblingDay + step - before;
        if (target >= 0 && target < modifiers.length) {
          modifiers[target] = f32(modifiers[target]! * SIBLING_MODIFIER_RANGE[k]!);
        }
      });
    }
    return modifiers;
  }
}

function calculateEasyDaysModifiers(easyDays: EasyDay[], weekdays: number[], reviewCounts: number[]): number[] {
  const totalReviews = reviewCounts.reduce((a, b) => a + b, 0);
  let totalPercents = 0;
  for (const w of weekdays) totalPercents = f32(totalPercents + loadModifier(easyDays[w]!));
  return weekdays.map((w, i) => {
    let day = easyDays[w]!;
    if (day === "reduced") {
      const count = reviewCounts[i]!;
      const otherDaysReviewTotal = f32(totalReviews - count);
      const otherDaysPercentTotal = f32(totalPercents - 0.5);
      const normalizedCount = f32(count / 0.5);
      const threshold = f32(otherDaysReviewTotal / otherDaysPercentTotal);
      day = normalizedCount > threshold ? "minimum" : "normal";
    }
    return loadModifier(day);
  });
}

/** Weekday (Monday = 0) of the day a card with this interval would be due. */
export function intervalToWeekday(interval: number, nextDayAt: number): number {
  const d = new Date((nextDayAt + (interval - 1) * 86_400) * 1000);
  return (d.getDay() + 6) % 7;
}
