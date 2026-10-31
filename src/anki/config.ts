// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed views over the schema-11 JSON stored in the `col` row, following the
// serde defaults in rslib/src/deckconfig/schema11.rs and
// rslib/src/decks/schema11.rs (Copyright: Ankitects Pty Ltd and contributors).

import { f32 } from "./rng";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export interface DeckConfig {
  id: number;
  name: string;
  learnSteps: number[];
  relearnSteps: number[];
  newPerDay: number;
  reviewsPerDay: number;
  initialEase: number;
  easyMultiplier: number;
  hardMultiplier: number;
  lapseMultiplier: number;
  intervalMultiplier: number;
  maximumReviewInterval: number;
  minimumLapseInterval: number;
  graduatingIntervalGood: number;
  graduatingIntervalEasy: number;
  newGatherPriority: number;
  newSortOrder: number;
  reviewOrder: number;
  newMix: number;
  interdayLearningMix: number;
  /** 0 = suspend, 1 = tag only */
  leechAction: number;
  leechThreshold: number;
  capAnswerTimeToSecs: number;
  showTimer: boolean;
  autoplay: boolean;
  replayQuestion: boolean;
  buryNew: boolean;
  buryReviews: boolean;
  buryInterdayLearning: boolean;
  easyDaysPercentages: number[];
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

function numArray(v: unknown, fallback: number[]): number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : fallback;
}

export function parseDeckConfig(raw: Json): DeckConfig {
  const n = raw?.new ?? {};
  const r = raw?.rev ?? {};
  const l = raw?.lapse ?? {};
  const ints = Array.isArray(n.ints) && n.ints.length >= 2 ? n.ints : [1, 4];
  return {
    id: num(raw?.id, 1),
    name: typeof raw?.name === "string" ? raw.name : "Default",
    learnSteps: numArray(n.delays, [1, 10]),
    relearnSteps: numArray(l.delays, [10]),
    newPerDay: num(n.perDay, 20),
    reviewsPerDay: num(r.perDay, 200),
    initialEase: f32(f32(num(n.initialFactor, 2500)) / 1000),
    easyMultiplier: f32(num(r.ease4, 1.3)),
    hardMultiplier: f32(num(r.hardFactor, 1.2)),
    lapseMultiplier: f32(num(l.mult, 0)),
    intervalMultiplier: f32(num(r.ivlFct, 1)),
    maximumReviewInterval: num(r.maxIvl, 36500),
    minimumLapseInterval: num(l.minInt, 1),
    graduatingIntervalGood: num(ints[0], 1),
    graduatingIntervalEasy: num(ints[1], 4),
    newGatherPriority: num(raw?.newGatherPriority, 0),
    newSortOrder: num(raw?.newSortOrder, 0),
    reviewOrder: num(raw?.reviewOrder, 0),
    newMix: num(raw?.newMix, 0),
    interdayLearningMix: num(raw?.interdayLearningMix, 0),
    leechAction: num(l.leechAction, 1),
    leechThreshold: num(l.leechFails, 8),
    capAnswerTimeToSecs: Math.max(num(raw?.maxTaken, 60), 0),
    showTimer: num(raw?.timer, 0) !== 0,
    autoplay: raw?.autoplay !== false,
    replayQuestion: raw?.replayq !== false,
    buryNew: !!n.bury,
    buryReviews: !!r.bury,
    buryInterdayLearning: !!raw?.buryInterdayLearning,
    easyDaysPercentages: numArray(raw?.easyDaysPercentages, []),
  };
}

export interface DayLimit {
  limit: number;
  today: number;
}

export interface Deck {
  id: number;
  name: string;
  /** Normal decks only; filtered decks are not supported yet. */
  filtered: boolean;
  configId: number;
  collapsed: boolean;
  lastDayStudied: number;
  newStudied: number;
  reviewStudied: number;
  learningStudied: number;
  millisecondsStudied: number;
  reviewLimit: number | null;
  newLimit: number | null;
  reviewLimitToday: DayLimit | null;
  newLimitToday: DayLimit | null;
  description: string;
}

function todayAmount(v: unknown): [number, number] {
  if (Array.isArray(v)) return [num(v[0], 0), num(v[1], 0)];
  return [0, 0];
}

function optLimit(v: unknown): number | null {
  return typeof v === "number" && v >= 0 ? v : null;
}

function optDayLimit(v: Json): DayLimit | null {
  if (v && typeof v === "object" && typeof v.limit === "number" && typeof v.today === "number") {
    return { limit: v.limit, today: v.today };
  }
  return null;
}

export function parseDeck(raw: Json): Deck {
  const [lrnDay, lrnAmt] = todayAmount(raw?.lrnToday);
  const [revDay, revAmt] = todayAmount(raw?.revToday);
  const [newDay, newAmt] = todayAmount(raw?.newToday);
  const [timeDay, timeAmt] = todayAmount(raw?.timeToday);
  const maxDay = Math.max(timeDay, newDay, revDay);
  return {
    id: num(raw?.id, 0),
    name: String(raw?.name ?? ""),
    filtered: num(raw?.dyn, 0) !== 0,
    configId: num(raw?.conf, 1),
    collapsed: !!raw?.collapsed,
    lastDayStudied: Math.max(maxDay, 0),
    newStudied: newDay === maxDay ? newAmt : 0,
    reviewStudied: revDay === maxDay ? revAmt : 0,
    learningStudied: lrnDay === maxDay ? lrnAmt : 0,
    millisecondsStudied: timeAmt,
    reviewLimit: optLimit(raw?.reviewLimit),
    newLimit: optLimit(raw?.newLimit),
    reviewLimitToday: optDayLimit(raw?.reviewLimitToday),
    newLimitToday: optDayLimit(raw?.newLimitToday),
    description: typeof raw?.desc === "string" ? raw.desc : "",
  };
}

/** Write a deck's study counters back into its schema-11 JSON. */
export function writeDeckToday(raw: Json, deck: Deck): void {
  const day = deck.lastDayStudied;
  raw.lrnToday = [day, deck.learningStudied];
  raw.revToday = [day, deck.reviewStudied];
  raw.newToday = [day, deck.newStudied];
  raw.timeToday = [day, deck.millisecondsStudied];
}

/** Anki deck names are compared component-wise, case-insensitively. */
export function deckNameKey(name: string): string {
  return name
    .split("::")
    .map((c) => c.toLowerCase())
    .join("\x1f");
}

export function compareDeckNames(a: string, b: string): number {
  const ka = deckNameKey(a);
  const kb = deckNameKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
