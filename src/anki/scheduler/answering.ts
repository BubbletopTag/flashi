// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/scheduler/answering/{mod,current,learning,review,relearning,revlog}.rs
// (Copyright: Ankitects Pty Ltd and contributors), SM-2 only.

import type { DeckConfig } from "../config";
import { CardQueue, CardType, parseCardData, serializeCardData, type Card, type RevlogEntry } from "../model";
import { ChaCha12Rng, f32, randomRangeF32, randomRangeU32 } from "../rng";
import {
  asU32,
  intervalAsRevlog,
  intervalAsSeconds,
  intervalKind,
  isLeeched,
  LearningSteps,
  maybeAsDays,
  nextStates,
  revlogKind,
  roundF32,
  type CardState,
  type LearnState,
  type LoadBalancerHook,
  type SchedulingStates,
  type StateContext,
} from "./states";
import type { SchedTimingToday } from "./timing";
import { answerButtonTimeCollapsible } from "./timespan";

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const;
export type RatingValue = (typeof Rating)[keyof typeof Rating];

/** `card.id + card.reps` (u64 wrapping); Anki disables this in its own unit tests. */
export function fuzzSeed(cardId: number, reps: number): bigint {
  return BigInt.asUintN(64, BigInt(cardId) + BigInt(reps));
}

export function fuzzFactor(seed: bigint): number {
  return randomRangeF32(ChaCha12Rng.seedFromU64(seed), 0, 1);
}

/** Add up to 25% to a learning delay, but no more than 5 minutes. */
export function learningIvlWithFuzz(seed: bigint | null, secs: number): number {
  if (seed === null) return secs;
  const upperExclusive = secs + asU32(Math.floor(Math.min(f32(f32(secs) * 0.25), 300)));
  if (secs >= upperExclusive) return secs;
  return randomRangeU32(ChaCha12Rng.seedFromU64(seed), secs, upperExclusive);
}

export interface AnswerContext {
  config: DeckConfig;
  timing: SchedTimingToday;
  /** Current time in seconds. */
  now: number;
  /** Disable fuzz (Anki does this when running its own tests). */
  noFuzz?: boolean;
  loadBalancer?: LoadBalancerHook | null;
}

function secsUntilRollover(ctx: AnswerContext): number {
  return ctx.timing.nextDayAt - ctx.now;
}

export function stateContext(card: Card, ctx: AnswerContext): StateContext {
  const c = ctx.config;
  const seed = ctx.noFuzz ? null : fuzzSeed(card.id, card.reps);
  return {
    fuzzFactor: seed === null ? null : fuzzFactor(seed),
    steps: new LearningSteps(c.learnSteps),
    graduatingIntervalGood: c.graduatingIntervalGood,
    graduatingIntervalEasy: c.graduatingIntervalEasy,
    initialEaseFactor: c.initialEase,
    hardMultiplier: c.hardMultiplier,
    easyMultiplier: c.easyMultiplier,
    intervalMultiplier: c.intervalMultiplier,
    maximumReviewInterval: c.maximumReviewInterval,
    leechThreshold: c.leechThreshold,
    loadBalancer: ctx.loadBalancer ?? null,
    relearnSteps: new LearningSteps(c.relearnSteps),
    lapseMultiplier: c.lapseMultiplier,
    minimumLapseInterval: c.minimumLapseInterval,
  };
}

/** `current_card_state` for a card in a normal (non-filtered) deck. */
export function currentCardState(card: Card, ctx: AnswerContext): CardState {
  const today = ctx.timing.daysElapsed;
  const due = card.type === CardType.Review ? Math.min(card.due, today) : card.due;
  const remainingSteps = card.left % 1000;
  const ease = f32(f32(card.factor) / 1000);
  const elapsedSecs = (lastIvl: number): number => {
    if (card.queue === CardQueue.Learn) {
      const seed = ctx.noFuzz ? null : fuzzSeed(card.id, (card.reps - 1) >>> 0);
      const lastAnswered = due - learningIvlWithFuzz(seed, lastIvl);
      return (ctx.now - lastAnswered) >>> 0;
    }
    if (card.queue === CardQueue.DayLearn) {
      const elapsedDays = today - due + Math.max(Math.floor(lastIvl / 86_400), 1);
      return (elapsedDays * 86_400) >>> 0;
    }
    return 0;
  };
  switch (card.type) {
    case CardType.New:
      return { kind: "new", position: Math.max(due, 0) };
    case CardType.Learn: {
      const lastIvl = new LearningSteps(ctx.config.learnSteps).currentDelaySecs(remainingSteps);
      return { kind: "learning", scheduledSecs: lastIvl, remainingSteps, elapsedSecs: elapsedSecs(lastIvl) };
    }
    case CardType.Review:
      return {
        kind: "review",
        scheduledDays: card.ivl,
        elapsedDays: Math.max(card.ivl - (due - today), 0),
        easeFactor: ease,
        lapses: card.lapses,
        leeched: false,
      };
    default: {
      const lastIvl = new LearningSteps(ctx.config.relearnSteps).currentDelaySecs(remainingSteps);
      return {
        kind: "relearning",
        learning: { kind: "learning", scheduledSecs: lastIvl, elapsedSecs: elapsedSecs(lastIvl), remainingSteps },
        review: {
          kind: "review",
          scheduledDays: card.ivl,
          elapsedDays: card.ivl,
          easeFactor: ease,
          lapses: card.lapses,
          leeched: false,
        },
      };
    }
  }
}

export function nextStatesFor(card: Card, ctx: AnswerContext): SchedulingStates {
  return nextStates(currentCardState(card, ctx), stateContext(card, ctx));
}

/** Labels for the four answer buttons ("<1m", "<6m", "<10m", "4d"). */
export function describeNextStates(states: SchedulingStates, ctx: AnswerContext, learnAheadSecs: number): string[] {
  const rollover = Math.max(secsUntilRollover(ctx), 0);
  return [states.again, states.hard, states.good, states.easy].map((s) =>
    answerButtonTimeCollapsible(intervalAsSeconds(maybeAsDays(intervalKind(s), rollover)), learnAheadSecs),
  );
}

export interface AnswerResult {
  card: Card;
  revlog: RevlogEntry;
  leeched: boolean;
}

/**
 * Apply `next` to `card` the way `answer_card_inner` does (without the
 * queue/deck-stat bookkeeping, which the collection layer handles).
 */
export function applyAnswer(
  original: Card,
  current: CardState,
  next: CardState,
  rating: number,
  answeredAtMs: number,
  millisecondsTaken: number,
  ctx: AnswerContext,
): AnswerResult {
  const card: Card = { ...original };
  const data = parseCardData(card.data);
  const seed = ctx.noFuzz ? null : fuzzSeed(original.id, original.reps);
  const rollover = secsUntilRollover(ctx);
  const today = ctx.timing.daysElapsed;
  const newPosition = current.kind === "new" ? current.position : null;
  card.reps += 1;

  const placeLearning = (learning: LearnState) => {
    const ivl = maybeAsDays({ secs: learning.scheduledSecs }, rollover);
    if (ivl.secs !== undefined) {
      card.queue = CardQueue.Learn;
      card.due = ctx.now + learningIvlWithFuzz(seed, ivl.secs);
    } else {
      card.queue = CardQueue.DayLearn;
      card.due = today + ivl.days;
    }
  };

  let revlogEase = 0;
  switch (next.kind) {
    case "new":
      card.type = CardType.New;
      card.queue = CardQueue.New;
      card.due = next.position;
      delete data.pos;
      break;
    case "learning":
      card.left = next.remainingSteps;
      card.type = CardType.Learn;
      if (newPosition !== null) data.pos = newPosition;
      placeLearning(next);
      break;
    case "review":
      card.queue = CardQueue.Review;
      card.type = CardType.Review;
      card.ivl = next.scheduledDays;
      card.due = today + next.scheduledDays;
      card.factor = roundF32(f32(next.easeFactor * 1000));
      card.lapses = next.lapses;
      card.left = 0;
      if (newPosition !== null) data.pos = newPosition;
      revlogEase = next.easeFactor;
      break;
    case "relearning":
      card.ivl = next.review.scheduledDays;
      card.left = next.learning.remainingSteps;
      card.type = CardType.Relearn;
      card.lapses = next.review.lapses;
      card.factor = roundF32(f32(next.review.easeFactor * 1000));
      if (newPosition !== null) data.pos = newPosition;
      placeLearning(next.learning);
      revlogEase = next.review.easeFactor;
      break;
  }

  const leeched = isLeeched(next);
  if (leeched && ctx.config.leechAction === 0) card.queue = CardQueue.Suspended;

  data.lrt = Math.floor(answeredAtMs / 1000);
  card.data = serializeCardData(data);
  card.mod = ctx.now;
  card.usn = -1;

  const revlog: RevlogEntry = {
    id: answeredAtMs,
    cid: card.id,
    usn: -1,
    ease: rating,
    ivl: intervalAsRevlog(maybeAsDays(intervalKind(next), rollover)),
    lastIvl: intervalAsRevlog(maybeAsDays(intervalKind(current), rollover)),
    factor: roundF32(f32(revlogEase * 1000)),
    time: Math.min(millisecondsTaken, ctx.config.capAnswerTimeToSecs * 1000),
    type: revlogKind(current),
  };
  return { card, revlog, leeched };
}

export function stateForRating(states: SchedulingStates, rating: number): CardState {
  switch (rating) {
    case Rating.Again:
      return states.again;
    case Rating.Hard:
      return states.hard;
    case Rating.Good:
      return states.good;
    default:
      return states.easy;
  }
}
