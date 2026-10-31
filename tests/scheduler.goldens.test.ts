// SPDX-License-Identifier: AGPL-3.0-or-later
// Compares Flashi's scheduler port with decisions recorded from the official
// `anki` package by scripts/make-logic-goldens.py.

import { describe, expect, it } from "vitest";
import goldens from "../fixtures/logic-goldens.json";
import { parseDeckConfig } from "../src/anki/config";
import type { Card } from "../src/anki/model";
import {
  applyAnswer,
  currentCardState,
  describeNextStates,
  fuzzSeed,
  nextStatesFor,
  stateForRating,
  type AnswerContext,
} from "../src/anki/scheduler/answering";
import { LoadBalancer } from "../src/anki/scheduler/loadBalancer";
import type { CardState } from "../src/anki/scheduler/states";
import { schedTimingToday } from "../src/anki/scheduler/timing";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Snapshot = any;

function contextFor(s: Snapshot): AnswerContext {
  const now = Math.floor(s.now);
  const t = s.timing;
  const timing = schedTimingToday(t.crt, now, t.creationOffset ?? null, t.currentMinutesWest, t.rollover);
  return { config: parseDeckConfig(s.config), timing, now };
}

function toProto(state: CardState): any {
  switch (state.kind) {
    case "new":
      return { normal: { new: { position: state.position } } };
    case "learning":
      return { normal: { learning: learnProto(state) } };
    case "review":
      return { normal: { review: reviewProto(state) } };
    case "relearning":
      return { normal: { relearning: { learning: learnProto(state.learning), review: reviewProto(state.review) } } };
  }
}

function learnProto(s: { remainingSteps: number; scheduledSecs: number; elapsedSecs: number }) {
  return { remaining_steps: s.remainingSteps, scheduled_secs: s.scheduledSecs, elapsed_secs: s.elapsedSecs };
}

function reviewProto(s: { scheduledDays: number; elapsedDays: number; easeFactor: number; lapses: number; leeched: boolean }) {
  return {
    scheduled_days: s.scheduledDays,
    elapsed_days: s.elapsedDays,
    ease_factor: shortestF32(s.easeFactor),
    lapses: s.lapses,
    leeched: s.leeched,
  };
}

/** Protobuf prints float fields with the shortest repr that round-trips as f32. */
function shortestF32(x: number): number {
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(x.toPrecision(p));
    if (Math.fround(candidate) === x) return candidate;
  }
  return x;
}

/** elapsed_secs depends on the wall clock; allow the recorded "now" to be 1s off. */
function normalizeElapsed(value: any, other: any): any {
  if (value && typeof value === "object") {
    const out: any = Array.isArray(value) ? [] : {};
    for (const k of Object.keys(value)) {
      if (k === "elapsed_secs" && Math.abs(value[k] - (other?.[k] ?? NaN)) <= 1) out[k] = other[k];
      else out[k] = normalizeElapsed(value[k], other?.[k]);
    }
    return out;
  }
  return value;
}

function expectStates(s: Snapshot, ctx: AnswerContext) {
  const states = nextStatesFor(s.card as Card, ctx);
  const actual = {
    current: toProto(states.current),
    again: toProto(states.again),
    hard: toProto(states.hard),
    good: toProto(states.good),
    easy: toProto(states.easy),
  };
  expect(normalizeElapsed(actual, s.states), s.name).toEqual(s.states);
  expect(describeNextStates(states, ctx, 1200), s.name).toEqual(s.labels);
}

describe("scheduler matches Anki " + goldens.anki, () => {
  it("computes the same day number and rollover", () => {
    for (const s of goldens.scenarios as Snapshot[]) {
      const ctx = contextFor(s);
      expect(ctx.timing.daysElapsed).toBe(s.timing.today);
      expect(ctx.timing.nextDayAt).toBe(s.timing.dayCutoff);
    }
  });

  for (const s of goldens.scenarios as Snapshot[]) {
    it(`states and labels: ${s.name}`, () => expectStates(s, contextFor(s)));
  }

  for (const a of goldens.answers as Snapshot[]) {
    it(`answer: ${a.name}`, () => {
      const ctx = contextFor(a);
      expectStates(a, ctx);
      const before = a.before as Card;
      const states = nextStatesFor(before, ctx);
      const revlog = a.after.revlog;
      const answeredAtMs = revlog.id;
      ctx.now = Math.floor(answeredAtMs / 1000);
      const result = applyAnswer(
        before,
        currentCardState(before, ctx),
        stateForRating(states, a.rating),
        a.rating,
        answeredAtMs,
        revlog.time,
        ctx,
      );
      const { mod: _m1, due: dueActual, ...restActual } = result.card;
      const { mod: _m2, due: dueExpected, ...restExpected } = a.after.card;
      expect(restActual, a.name).toEqual(restExpected);
      // Learning due dates are "now + fuzzed delay"; Anki reads the clock again
      // after the answer timestamp, so allow it to have ticked over by a second.
      const slack = a.after.card.queue === 1 ? 1 : 0;
      expect(dueExpected - dueActual, a.name).toBeGreaterThanOrEqual(0);
      expect(dueExpected - dueActual, a.name).toBeLessThanOrEqual(slack);
      expect(result.revlog, a.name).toEqual(revlog);
    });
  }

  describe("load balancer", () => {
    const lb = goldens.loadBalancer as Snapshot;
    for (const s of lb.scenarios as Snapshot[]) {
      it(s.name, () => {
        const ctx = contextFor(s);
        const didToDcid = new Map<number, number>();
        for (const [did, d] of Object.entries(lb.decks as Record<string, any>)) {
          if (!d.dyn) didToDcid.set(Number(did), Number(d.conf));
        }
        const today = ctx.timing.daysElapsed;
        const rows = (lb.cards as any[])
          .filter((c) => c.due >= today && c.due < today + 99)
          .map((c) => ({ cid: c.id, nid: c.nid, did: c.did, due: c.due }));
        const balancer = new LoadBalancer(
          today,
          rows,
          didToDcid,
          new Map([[ctx.config.id, ctx.config.easyDaysPercentages]]),
          ctx.timing.nextDayAt,
        );
        const card = s.card as Card;
        const seed = fuzzSeed(card.id, card.reps);
        ctx.loadBalancer = {
          findInterval: (interval, min, max) =>
            balancer.findInterval(interval, min, max, didToDcid.get(card.did)!, seed, null),
        };
        expectStates(s, ctx);
      });
    }
  });
});
