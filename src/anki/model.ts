// SPDX-License-Identifier: AGPL-3.0-or-later
// Schema-11 row types and enums (see rslib/src/storage/schema11.sql and
// rslib/src/card/mod.rs, Copyright: Ankitects Pty Ltd and contributors).

export const CardType = { New: 0, Learn: 1, Review: 2, Relearn: 3 } as const;

export const CardQueue = {
  UserBuried: -3,
  SchedBuried: -2,
  Suspended: -1,
  New: 0,
  Learn: 1,
  Review: 2,
  DayLearn: 3,
  PreviewRepeat: 4,
} as const;

export interface Card {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

export interface Note {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string;
  flds: string;
  sfld: string | number;
  csum: number;
  flags: number;
  data: string;
}

export interface RevlogEntry {
  id: number;
  cid: number;
  usn: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

export interface CardData {
  pos?: number;
  s?: number;
  d?: number;
  dr?: number;
  decay?: number;
  lrt?: number;
  cd?: string;
}

export function parseCardData(data: string): CardData {
  if (!data) return {};
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CardData) : {};
  } catch {
    return {};
  }
}

/** Serialize with Anki's field order, omitting unset fields. */
export function serializeCardData(d: CardData): string {
  const out: Record<string, unknown> = {};
  for (const key of ["pos", "s", "d", "dr", "decay", "lrt"] as const) {
    if (d[key] !== undefined && d[key] !== null) out[key] = d[key];
  }
  if (d.cd && d.cd !== "{}") out.cd = d.cd;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

export function splitFields(flds: string): string[] {
  return flds.split("\x1f");
}

export function splitTags(tags: string): string[] {
  return tags.split(/\s+/).filter(Boolean);
}

export function joinTags(tags: string[]): string {
  return tags.length ? ` ${tags.join(" ")} ` : "";
}

export function cardFlag(card: Card): number {
  return card.flags & 0b111;
}
