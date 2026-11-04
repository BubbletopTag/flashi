// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of Anki's SM-2 card state machine (rslib/src/scheduler/states/*.rs).
// Copyright: Ankitects Pty Ltd and contributors (original Rust).
// FSRS and filtered-deck states are not ported yet (Phase 4).
//
// Rust does this arithmetic in f32; every float operation below is rounded
// with Math.fround so results (and therefore fuzz rounding) match bit for bit.

import { f32 } from "../rng";

export const INITIAL_EASE_FACTOR = f32(2.5);
export const MINIMUM_EASE_FACTOR = f32(1.3);
const EASE_FACTOR_AGAIN_DELTA = f32(-0.2);
const EASE_FACTOR_HARD_DELTA = f32(-0.15);
const EASE_FACTOR_EASY_DELTA = f32(0.15);
const DAY = 86_400;

export interface NewState {
  kind: "new";
  position: number;
}

export interface LearnState {
  memory?: { stability: number; difficulty: number };
  kind: "learning";
  remainingSteps: number;
  scheduledSecs: number;
  elapsedSecs: number;
}

export interface ReviewState {
  memory?: { stability: number; difficulty: number };
  kind: "review";
  scheduledDays: number;
  elapsedDays: number;
  easeFactor: number;
  lapses: number;
  leeched: boolean;
}

export interface RelearnState {
  kind: "relearning";
  learning: LearnState;
  review: ReviewState;
}

export type CardState = NewState | LearnState | ReviewState | RelearnState;

export interface SchedulingStates {
  current: CardState;
  again: CardState;
  hard: CardState;
  good: CardState;
  easy: CardState;
}

export type IntervalKind = { secs: number; days?: undefined } | { days: number; secs?: undefined };

export const RevlogKind = {
  Learning: 0,
  Review: 1,
  Relearning: 2,
  Filtered: 3,
  Manual: 4,
  Rescheduled: 5,
} as const;

/** Rust `f32::round` (half away from zero). */
export function roundF32(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/** Rust `x as u32` for floats: truncate, saturate, NaN → 0. */
export function asU32(x: number): number {
  if (!(x > 0)) return 0;
  return Math.min(Math.trunc(x), 0xffffffff);
}

function satSub(a: number, b: number): number {
  return a > b ? a - b : 0;
}

// ---------------------------------------------------------------- steps.rs

export class LearningSteps {
  /** Steps in minutes (f32). */
  readonly steps: readonly number[];
  constructor(steps: readonly number[]) {
    this.steps = steps.map((s) => f32(s));
  }

  private getIndex(remaining: number): number {
    const total = this.steps.length;
    return Math.min(satSub(total, remaining % 1000), satSub(total, 1));
  }

  private secsAtIndex(index: number): number | null {
    const v = this.steps[index];
    return v === undefined ? null : asU32(f32(v * 60));
  }

  againDelaySecsLearn(): number | null {
    return this.secsAtIndex(0);
  }

  hardDelaySecs(remaining: number): number | null {
    const idx = this.getIndex(remaining);
    const current = this.secsAtIndex(idx) ?? this.secsAtIndex(0);
    if (current === null) return null;
    return idx === 0 ? this.hardDelaySecsForFirstStep(current) : current;
  }

  private hardDelaySecsForFirstStep(againSecs: number): number {
    const next = this.secsAtIndex(1);
    if (next !== null) {
      return maybeRoundInDays(Math.floor(Math.min(againSecs + next, 0xffffffff) / 2));
    }
    const secs = Math.min(Math.floor((againSecs * 3) / 2), againSecs + DAY);
    return maybeRoundInDays(secs);
  }

  goodDelaySecs(remaining: number): number | null {
    return this.secsAtIndex(this.getIndex(remaining) + 1);
  }

  currentDelaySecs(remaining: number): number {
    return this.secsAtIndex(this.getIndex(remaining)) ?? 0;
  }

  remainingForGood(remaining: number): number {
    return satSub(this.steps.length, this.getIndex(remaining) + 1);
  }

  remainingForFailed(): number {
    return this.steps.length;
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }
}

function maybeRoundInDays(secs: number): number {
  if (secs > DAY) return asU32(roundF32(f32(f32(secs) / DAY))) * DAY;
  return secs;
}

// ---------------------------------------------------------------- fuzz.rs

const FUZZ_RANGES = [
  { start: f32(2.5), end: f32(7.0), factor: f32(0.15) },
  { start: f32(7.0), end: f32(20.0), factor: f32(0.1) },
  { start: f32(20.0), end: 3.4028234663852886e38, factor: f32(0.05) },
];

function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  let delta = f32(1.0);
  for (const range of FUZZ_RANGES) {
    const inRange = Math.max(f32(Math.min(interval, range.end) - range.start), 0);
    delta = f32(delta + f32(range.factor * inRange));
  }
  return delta;
}

export function fuzzBounds(interval: number): [number, number] {
  const delta = fuzzDelta(interval);
  return [asU32(roundF32(f32(interval - delta))), asU32(roundF32(f32(interval + delta)))];
}

export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  minimum = Math.min(minimum, maximum);
  const clamped = Math.min(Math.max(f32(interval), minimum), maximum);
  let [lower, upper] = fuzzBounds(clamped);
  lower = Math.min(Math.max(lower, minimum), maximum);
  upper = Math.min(Math.max(upper, minimum), maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

export function withReviewFuzz(fuzzFactor: number | null, interval: number, minimum: number, maximum: number): number {
  if (fuzzFactor !== null) {
    const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
    return asU32(Math.floor(f32(lower + f32(fuzzFactor * (1 + upper - lower)))));
  }
  return Math.min(Math.max(asU32(roundF32(f32(interval))), minimum), maximum);
}

// ---------------------------------------------------------------- context

export interface LoadBalancerHook {
  findInterval(interval: number, minimum: number, maximum: number): number | null;
}

export interface StateContext {
  fuzzFactor: number | null;
  steps: LearningSteps;
  graduatingIntervalGood: number;
  graduatingIntervalEasy: number;
  initialEaseFactor: number;
  hardMultiplier: number;
  easyMultiplier: number;
  intervalMultiplier: number;
  maximumReviewInterval: number;
  leechThreshold: number;
  loadBalancer: LoadBalancerHook | null;
  relearnSteps: LearningSteps;
  lapseMultiplier: number;
  minimumLapseInterval: number;
}

export function minAndMaxReviewIntervals(ctx: StateContext, minimum: number): [number, number] {
  const maximum = Math.max(ctx.maximumReviewInterval, 1);
  return [Math.min(Math.max(minimum, 1), maximum), maximum];
}

export function ctxFuzz(ctx: StateContext, interval: number, minimum: number, maximum: number): number {
  const balanced = ctx.loadBalancer?.findInterval(interval, minimum, maximum) ?? null;
  return balanced ?? withReviewFuzz(ctx.fuzzFactor, interval, minimum, maximum);
}

// ---------------------------------------------------------------- learning.rs

function graduateToReview(ctx: StateContext, interval: number): ReviewState {
  const [minimum, maximum] = minAndMaxReviewIntervals(ctx, 1);
  return {
    kind: "review",
    scheduledDays: ctxFuzz(ctx, Math.max(roundF32(f32(interval)), 1), minimum, maximum),
    elapsedDays: 0,
    easeFactor: ctx.initialEaseFactor,
    lapses: 0,
    leeched: false,
  };
}

function learnNextStates(state: LearnState, ctx: StateContext): SchedulingStates {
  const againDelay = ctx.steps.againDelaySecsLearn();
  const again: CardState =
    againDelay !== null
      ? { kind: "learning", remainingSteps: ctx.steps.remainingForFailed(), scheduledSecs: againDelay, elapsedSecs: 0 }
      : graduateToReview(ctx, ctx.graduatingIntervalGood);

  const hardDelay = ctx.steps.hardDelaySecs(state.remainingSteps);
  const hard: CardState =
    hardDelay !== null
      ? { ...state, scheduledSecs: hardDelay, elapsedSecs: 0 }
      : graduateToReview(ctx, ctx.graduatingIntervalGood);

  const goodDelay = ctx.steps.goodDelaySecs(state.remainingSteps);
  const good: CardState =
    goodDelay !== null
      ? {
          kind: "learning",
          remainingSteps: ctx.steps.remainingForGood(state.remainingSteps),
          scheduledSecs: goodDelay,
          elapsedSecs: 0,
        }
      : graduateToReview(ctx, ctx.graduatingIntervalGood);

  const [minimum, maximum] = minAndMaxReviewIntervals(ctx, 1);
  const easy: ReviewState = {
    kind: "review",
    scheduledDays: ctxFuzz(ctx, f32(ctx.graduatingIntervalEasy), minimum, maximum),
    elapsedDays: 0,
    easeFactor: ctx.initialEaseFactor,
    lapses: 0,
    leeched: false,
  };
  return { current: state, again, hard, good, easy };
}

// ---------------------------------------------------------------- review.rs

function daysLate(state: ReviewState): number {
  return state.elapsedDays - state.scheduledDays;
}

/** True when lapses is at threshold, or every half threshold after that. */
export function leechThresholdMet(lapses: number, threshold: number): boolean {
  if (threshold <= 0) return false;
  const half = Math.max(Math.ceil(threshold / 2), 1);
  return lapses >= threshold && (lapses - threshold) % half === 0;
}

function constrainPassingInterval(ctx: StateContext, interval: number, minimum: number, fuzz: boolean): number {
  const scaled = f32(interval * ctx.intervalMultiplier);
  const [min, max] = minAndMaxReviewIntervals(ctx, minimum);
  if (fuzz) return ctxFuzz(ctx, scaled, min, max);
  return Math.min(Math.max(asU32(roundF32(scaled)), min), max);
}

function failingReviewInterval(state: ReviewState, ctx: StateContext): number {
  const [minimum, maximum] = minAndMaxReviewIntervals(ctx, ctx.minimumLapseInterval);
  const interval = f32(Math.max(f32(state.scheduledDays), 1) * ctx.lapseMultiplier);
  return ctxFuzz(ctx, interval, minimum, maximum);
}

function passingNonEarlyIntervals(state: ReviewState, ctx: StateContext): [number, number, number] {
  const current = Math.max(f32(state.scheduledDays), 1);
  const late = f32(Math.max(daysLate(state), 0));
  const hardFactor = ctx.hardMultiplier;
  const hardMinimum = hardFactor <= 1 ? 0 : state.scheduledDays + 1;
  const hard = constrainPassingInterval(ctx, f32(current * hardFactor), hardMinimum, true);
  const goodMinimum = hardFactor <= 1 ? state.scheduledDays + 1 : hard + 1;
  const good = constrainPassingInterval(ctx, f32(f32(current + f32(late / 2)) * state.easeFactor), goodMinimum, true);
  const easy = constrainPassingInterval(
    ctx,
    f32(f32(f32(current + late) * state.easeFactor) * ctx.easyMultiplier),
    good + 1,
    true,
  );
  return [hard, good, easy];
}

function passingEarlyIntervals(state: ReviewState, ctx: StateContext): [number, number, number] {
  const scheduled = Math.max(f32(state.scheduledDays), 1);
  const elapsed = f32(state.elapsedDays);
  const factor = ctx.hardMultiplier;
  const halfUsual = f32(factor / 2);
  const hard = constrainPassingInterval(ctx, Math.max(f32(elapsed * factor), f32(scheduled * halfUsual)), 0, false);
  const good = constrainPassingInterval(ctx, Math.max(f32(elapsed * state.easeFactor), scheduled), 0, false);
  const reducedBonus = f32(ctx.easyMultiplier - f32(f32(ctx.easyMultiplier - 1) / 2));
  const easy = constrainPassingInterval(
    ctx,
    f32(Math.max(f32(elapsed * state.easeFactor), scheduled) * reducedBonus),
    0,
    false,
  );
  return [hard, good, easy];
}

function reviewNextStates(state: ReviewState, ctx: StateContext): SchedulingStates {
  const [hardIvl, goodIvl, easyIvl] =
    daysLate(state) < 0 ? passingEarlyIntervals(state, ctx) : passingNonEarlyIntervals(state, ctx);

  const lapses = state.lapses + 1;
  const failDays = failingReviewInterval(state, ctx);
  const againReview: ReviewState = {
    kind: "review",
    scheduledDays: asU32(Math.max(roundF32(failDays), 1)),
    elapsedDays: 0,
    easeFactor: Math.max(f32(state.easeFactor + EASE_FACTOR_AGAIN_DELTA), MINIMUM_EASE_FACTOR),
    lapses,
    leeched: leechThresholdMet(lapses, ctx.leechThreshold),
  };
  const againDelay = ctx.relearnSteps.againDelaySecsLearn();
  const again: CardState =
    againDelay !== null
      ? {
          kind: "relearning",
          learning: {
            kind: "learning",
            remainingSteps: ctx.relearnSteps.remainingForFailed(),
            scheduledSecs: againDelay,
            elapsedSecs: 0,
          },
          review: againReview,
        }
      : againReview;

  return {
    current: state,
    again,
    hard: {
      ...state,
      scheduledDays: hardIvl,
      elapsedDays: 0,
      easeFactor: Math.max(f32(state.easeFactor + EASE_FACTOR_HARD_DELTA), MINIMUM_EASE_FACTOR),
    },
    good: { ...state, scheduledDays: goodIvl, elapsedDays: 0 },
    easy: { ...state, scheduledDays: easyIvl, elapsedDays: 0, easeFactor: f32(state.easeFactor + EASE_FACTOR_EASY_DELTA) },
  };
}

// ---------------------------------------------------------------- relearning.rs

function relearnNextStates(state: RelearnState, ctx: StateContext): SchedulingStates {
  const failDays = failingReviewInterval(state.review, ctx);
  const againDelay = ctx.relearnSteps.againDelaySecsLearn();
  const again: CardState =
    againDelay !== null
      ? {
          kind: "relearning",
          learning: {
            kind: "learning",
            remainingSteps: ctx.relearnSteps.remainingForFailed(),
            scheduledSecs: againDelay,
            elapsedSecs: 0,
          },
          review: { ...state.review, scheduledDays: asU32(Math.max(roundF32(failDays), 1)), elapsedDays: 0 },
        }
      : state.review;

  const hardDelay = ctx.relearnSteps.hardDelaySecs(state.learning.remainingSteps);
  const hard: CardState =
    hardDelay !== null
      ? {
          kind: "relearning",
          learning: { ...state.learning, scheduledSecs: hardDelay },
          review: { ...state.review, elapsedDays: 0 },
        }
      : state.review;

  const goodDelay = ctx.relearnSteps.goodDelaySecs(state.learning.remainingSteps);
  const good: CardState =
    goodDelay !== null
      ? {
          kind: "relearning",
          learning: {
            kind: "learning",
            scheduledSecs: goodDelay,
            remainingSteps: ctx.relearnSteps.remainingForGood(state.learning.remainingSteps),
            elapsedSecs: 0,
          },
          review: { ...state.review, elapsedDays: 0 },
        }
      : state.review;

  const easy: ReviewState = { ...state.review, scheduledDays: state.review.scheduledDays + 1, elapsedDays: 0 };
  return { current: state, again, hard, good, easy };
}

// ---------------------------------------------------------------- normal.rs

export function nextStates(state: CardState, ctx: StateContext): SchedulingStates {
  switch (state.kind) {
    case "new": {
      // A new card acts like a failed learning card, but with current = New.
      const learn: LearnState = {
        kind: "learning",
        remainingSteps: ctx.steps.remainingForFailed(),
        scheduledSecs: 0,
        elapsedSecs: 0,
      };
      return { ...learnNextStates(learn, ctx), current: state };
    }
    case "learning":
      return learnNextStates(state, ctx);
    case "review":
      return reviewNextStates(state, ctx);
    case "relearning":
      return relearnNextStates(state, ctx);
  }
}

export function intervalKind(state: CardState): IntervalKind {
  switch (state.kind) {
    case "new":
      return { secs: 0 };
    case "learning":
      return { secs: state.scheduledSecs };
    case "review":
      return { days: state.scheduledDays };
    case "relearning":
      return { secs: state.learning.scheduledSecs };
  }
}

/** Convert seconds-based intervals that pass the day barrier into days. */
export function maybeAsDays(kind: IntervalKind, secsUntilRollover: number): IntervalKind {
  if (kind.secs !== undefined && kind.secs >= secsUntilRollover) {
    return { days: Math.floor((kind.secs - secsUntilRollover) / DAY) + 1 };
  }
  return kind;
}

export function intervalAsSeconds(kind: IntervalKind): number {
  return kind.secs !== undefined ? kind.secs : kind.days * DAY;
}

export function intervalAsRevlog(kind: IntervalKind): number {
  return kind.secs !== undefined ? (kind.secs === 0 ? 0 : -kind.secs) : kind.days;
}

export function revlogKind(state: CardState): number {
  switch (state.kind) {
    case "new":
    case "learning":
      return RevlogKind.Learning;
    case "review":
      return daysLate(state) < 0 ? RevlogKind.Filtered : RevlogKind.Review;
    case "relearning":
      return RevlogKind.Relearning;
  }
}

export function isLeeched(state: CardState): boolean {
  if (state.kind === "review") return state.leeched;
  if (state.kind === "relearning") return state.review.leeched;
  return false;
}
