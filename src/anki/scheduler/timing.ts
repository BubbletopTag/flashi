// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/scheduler/timing.rs (Copyright: Ankitects Pty Ltd and contributors).

export interface SchedTimingToday {
  now: number;
  daysElapsed: number;
  nextDayAt: number;
}

const DAY = 86_400;

function clampMinutesWest(minutesWest: number): number {
  return Math.min(Math.max(minutesWest, -23 * 60), 23 * 60);
}

/** Local calendar day number for a timestamp at a fixed UTC offset. */
function localDay(secs: number, minutesWest: number): number {
  return Math.floor((secs - minutesWest * 60) / DAY);
}

/** Timestamp of `rolloverHour`:00 on the local day containing `secs`. */
function rolloverOnDayOf(secs: number, minutesWest: number, rolloverHour: number): number {
  return localDay(secs, minutesWest) * DAY + (rolloverHour % 24) * 3600 + minutesWest * 60;
}

/** Minutes west of UTC for the local timezone at `secs` (Anki's `localOffset`). */
export function localMinutesWest(secs: number): number {
  return new Date(secs * 1000).getTimezoneOffset();
}

export function schedTimingToday(
  creationSecs: number,
  nowSecs: number,
  creationMinutesWest: number | null,
  currentMinutesWest: number,
  rolloverHour: number | null,
): SchedTimingToday {
  if (rolloverHour === null) {
    // v1
    const daysElapsed = Math.trunc((nowSecs - creationSecs) / DAY);
    return { now: nowSecs, daysElapsed, nextDayAt: creationSecs + (daysElapsed + 1) * DAY };
  }
  const current = clampMinutesWest(currentMinutesWest);
  if (creationMinutesWest === null) {
    // v2 legacy
    const crtAtRollover = rolloverOnDayOf(creationSecs, current, rolloverHour);
    const daysElapsed = Math.trunc((nowSecs - crtAtRollover) / DAY);
    let nextDayAt = rolloverOnDayOf(nowSecs, current, rolloverHour);
    if (nextDayAt < nowSecs) nextDayAt += DAY;
    return { now: nowSecs, daysElapsed: Math.max(daysElapsed, 0) >>> 0, nextDayAt };
  }
  const creation = clampMinutesWest(creationMinutesWest);
  const rolloverToday = rolloverOnDayOf(nowSecs, current, rolloverHour);
  const rolloverPassed = rolloverToday <= nowSecs;
  const nextDayAt = rolloverPassed ? rolloverToday + DAY : rolloverToday;
  let days = localDay(nowSecs, current) - localDay(creationSecs, creation);
  if (!rolloverPassed) days -= 1;
  return { now: nowSecs, daysElapsed: Math.max(days, 0), nextDayAt };
}

/** The 4am-local creation stamp Anki gives new collections (`v1_creation_date`). */
export function v1CreationDate(nowSecs: number, minutesWest: number): number {
  const fourAm = rolloverOnDayOf(nowSecs, clampMinutesWest(minutesWest), 4);
  return fourAm > nowSecs ? fourAm - DAY : fourAm;
}
