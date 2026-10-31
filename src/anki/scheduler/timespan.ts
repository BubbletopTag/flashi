// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/scheduler/timespan.rs (Copyright: Ankitects Pty Ltd and contributors)
// with Anki's English strings from ftl/core/scheduling.ftl.

import { f32 } from "../rng";
import { roundF32 } from "./states";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const YEAR = f32(365 * DAY);
const MONTH = f32(YEAR / 12);

type Unit = "s" | "m" | "h" | "d" | "mo" | "y";

function naturalUnit(secs: number): Unit {
  const s = Math.abs(secs);
  if (s < MINUTE) return "s";
  if (s < HOUR) return "m";
  if (s < DAY) return "h";
  if (s < MONTH) return "d";
  if (s < YEAR) return "mo";
  return "y";
}

const DIVISOR: Record<Unit, number> = { s: 1, m: MINUTE, h: HOUR, d: DAY, mo: MONTH, y: YEAR };

/** Format like Fluent's NUMBER() with Anki's defaults (max 2 fraction digits). */
function formatAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/** `answer_button_time`: e.g. "10m", "1.5h", "4d", "2.3mo". */
export function answerButtonTime(seconds: number): string {
  const secs = f32(seconds);
  const unit = naturalUnit(secs);
  const asUnit = f32(secs / DIVISOR[unit]);
  const amount = unit === "s" || unit === "m" || unit === "d" ? roundF32(asUnit) : f32(roundF32(f32(asUnit * 10)) / 10);
  return `${formatAmount(amount)}${unit}`;
}

/** `answer_button_time_collapsible`: "(end)", "<10m", or the plain time. */
export function answerButtonTimeCollapsible(seconds: number, collapseSecs: number): string {
  const text = answerButtonTime(seconds);
  if (seconds === 0) return "(end)";
  if (seconds < collapseSecs) return `<${text}`;
  return text;
}
