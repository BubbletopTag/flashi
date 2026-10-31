// SPDX-License-Identifier: AGPL-3.0-or-later
// Read a schema-18 collection's notetypes/decks/deck_config/config/tags tables
// and convert them to schema-11 JSON, following rslib's schema-11 downgrade
// (rslib/src/{notetype,decks,deckconfig}/schema11.rs,
// Copyright: Ankitects Pty Ltd and contributors).

import type { Json } from "../config";
import { parseJson, taggedBigInt } from "../json";
import { f32 } from "../rng";
import { roundF32 } from "../scheduler/states";
import { num, str, type Db } from "../sqlite";
import { ProtoMessage } from "./protobuf";

export interface Schema11Json {
  conf: Json;
  models: Record<string, Json>;
  decks: Record<string, Json>;
  dconf: Record<string, Json>;
  tags: Record<string, number>;
}

const utf8 = new TextDecoder();

function otherJson(bytes: Uint8Array | null, reserved: readonly string[]): Json {
  if (!bytes || !bytes.length) return {};
  try {
    const v = parseJson<Json>(utf8.decode(bytes));
    if (!v || typeof v !== "object") return {};
    for (const k of reserved) delete v[k];
    return v;
  } catch {
    return {};
  }
}

function optionalId(m: ProtoMessage, field: number): number | string | null {
  const v = m.int64Big(field);
  return v === null ? null : taggedBigInt(v);
}

/** Shortest decimal that round-trips the f32 (what serde_json writes for an f32). */
function f32Json(v: number): number {
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(v.toPrecision(p));
    if (Math.fround(candidate) === Math.fround(v)) return candidate;
  }
  return v;
}

const REQ_KIND = ["none", "any", "all"];

function notetypes(db: Db): Record<string, Json> {
  const out: Record<string, Json> = {};
  const fields = new Map<number, Json[]>();
  for (const r of db.all("select ntid, ord, name, config from fields order by ntid, ord")) {
    const c = new ProtoMessage(r[3] as Uint8Array);
    const list = fields.get(num(r[0])) ?? [];
    list.push({
      name: str(r[2]),
      ord: num(r[1]),
      sticky: c.bool(1),
      rtl: c.bool(2),
      font: c.string(3),
      size: c.uint(4),
      description: c.string(5),
      plainText: c.bool(6),
      collapsed: c.bool(7),
      excludeFromSearch: c.bool(8),
      id: optionalId(c, 9),
      tag: c.has(10) ? c.uint(10) : null,
      preventDeletion: c.bool(11),
      ...otherJson(c.bytes(255), ["name", "ord", "sticky", "rtl", "plainText", "font", "size", "collapsed", "description", "excludeFromSearch", "id", "tag", "preventDeletion"]),
    });
    fields.set(num(r[0]), list);
  }
  const templates = new Map<number, Json[]>();
  for (const r of db.all("select ntid, ord, name, mtime_secs, usn, config from templates order by ntid, ord")) {
    const c = new ProtoMessage(r[5] as Uint8Array);
    const list = templates.get(num(r[0])) ?? [];
    const did = c.int64(5);
    list.push({
      name: str(r[2]),
      ord: num(r[1]),
      qfmt: c.string(1),
      afmt: c.string(2),
      bqfmt: c.string(3),
      bafmt: c.string(4),
      did: did > 0 ? did : null,
      bfont: c.string(6),
      bsize: c.uint(7),
      id: optionalId(c, 8),
      ...otherJson(c.bytes(255), ["name", "ord", "did", "afmt", "bafmt", "qfmt", "bqfmt", "bfont", "bsize", "id"]),
    });
    templates.set(num(r[0]), list);
  }
  for (const r of db.all("select id, name, mtime_secs, usn, config from notetypes")) {
    const id = num(r[0]);
    const c = new ProtoMessage(r[4] as Uint8Array);
    const did = c.int64(4);
    const model: Json = {
      id,
      name: str(r[1]),
      type: c.uint(1) === 1 ? 1 : 0,
      mod: num(r[2]),
      usn: num(r[3]),
      sortf: c.uint(2),
      did: did === 0 ? null : did,
      tmpls: templates.get(id) ?? [],
      flds: fields.get(id) ?? [],
      css: c.string(3),
      latexPre: c.string(5),
      latexPost: c.string(6),
      latexsvg: c.bool(7),
      req: c.messages(8).map((q) => [q.uint(1), REQ_KIND[q.uint(2)] ?? "none", q.uints(3)]),
      ...otherJson(c.bytes(255), ["latexPost", "flds", "css", "originalStockKind", "originalId", "id", "usn", "mod", "req", "latexPre", "name", "did", "tmpls", "type", "sortf", "latexsvg"]),
    };
    const stockKind = c.uint(9);
    if (stockKind) model.originalStockKind = stockKind;
    const originalId = c.int64Big(10);
    if (originalId !== null) model.originalId = taggedBigInt(originalId);
    out[String(id)] = model;
  }
  return out;
}

function dayLimit(m: ProtoMessage | null): Json {
  return m ? { limit: m.uint(1), today: m.uint(2) } : null;
}

function decks(db: Db): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const r of db.all("select id, name, mtime_secs, usn, common, kind from decks")) {
    const id = num(r[0]);
    const common = new ProtoMessage(r[4] as Uint8Array);
    const kind = new ProtoMessage(r[5] as Uint8Array);
    const day = common.uint(3);
    const base: Json = {
      id,
      mod: num(r[2]),
      name: str(r[1]).split("\x1f").join("::"),
      usn: num(r[3]),
      lrnToday: [day, common.int32(6)],
      revToday: [day, common.int32(5)],
      newToday: [day, common.int32(4)],
      timeToday: [day, common.int32(7)],
      collapsed: common.bool(1),
      browserCollapsed: common.bool(2),
      ...otherJson(common.bytes(255), ["id", "mod", "name", "usn", "lrnToday", "revToday", "newToday", "timeToday", "collapsed", "browserCollapsed", "desc", "md", "dyn"]),
    };
    const normal = kind.message(1);
    const filtered = kind.message(2);
    if (filtered) {
      out[String(id)] = {
        ...base,
        desc: "",
        dyn: 1,
        resched: filtered.bool(1),
        terms: filtered.messages(2).map((t) => [t.string(1), t.uint(2), t.uint(3)]),
        separate: true,
        delays: filtered.floats(3).length ? filtered.floats(3).map(f32Json) : null,
        previewDelay: filtered.uint(4),
        previewAgainSecs: filtered.uint(7),
        previewHardSecs: filtered.uint(5),
        previewGoodSecs: filtered.uint(6),
      };
    } else {
      const n = normal ?? new ProtoMessage(null);
      const deck: Json = {
        ...base,
        desc: n.string(4),
        dyn: 0,
        conf: n.int64(1, 1) || 1,
        extendNew: n.uint(2),
        extendRev: n.uint(3),
        reviewLimit: n.has(6) ? n.uint(6) : null,
        newLimit: n.has(7) ? n.uint(7) : null,
        reviewLimitToday: dayLimit(n.message(8)),
        newLimitToday: dayLimit(n.message(9)),
        desiredRetention: n.has(10) ? Math.round(n.float(10) * 100) : null,
      };
      if (n.bool(5)) deck.md = true;
      out[String(id)] = deck;
    }
  }
  return out;
}

function deckConfigs(db: Db): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const r of db.all("select id, name, mtime_secs, usn, config from deck_config")) {
    const id = num(r[0]);
    const c = new ProtoMessage(r[4] as Uint8Array);
    const other = otherJson(c.bytes(255), []);
    const sub = (key: string): Json => {
      const v = other[key];
      delete other[key];
      return v && typeof v === "object" ? v : {};
    };
    const newOther = sub("new");
    const revOther = sub("rev");
    const lapseOther = sub("lapse");
    out[String(id)] = {
      id,
      mod: num(r[2]),
      name: str(r[1]),
      usn: num(r[3]),
      maxTaken: c.uint(24),
      autoplay: !c.bool(23),
      timer: c.bool(25) ? 1 : 0,
      replayq: !c.bool(26),
      new: {
        ...newOther,
        bury: c.bool(27),
        delays: c.floats(1).map(f32Json),
        initialFactor: roundF32(f32(c.float(11) * 1000)),
        ints: [c.uint(18), c.uint(19), 0],
        order: c.uint(20) === 1 ? 0 : 1,
        perDay: c.uint(9),
      },
      rev: {
        ...revOther,
        bury: c.bool(28),
        ease4: f32Json(c.float(12)),
        ivlFct: f32Json(c.float(15)),
        maxIvl: c.uint(16),
        perDay: c.uint(10),
        hardFactor: f32Json(c.float(13)),
      },
      lapse: {
        ...lapseOther,
        delays: c.floats(2).map(f32Json),
        leechAction: c.uint(21),
        leechFails: c.uint(22),
        minInt: c.uint(17),
        mult: f32Json(c.float(14)),
      },
      dyn: false,
      newMix: c.uint(30),
      newPerDayMinimum: c.uint(35),
      interdayLearningMix: c.uint(31),
      reviewOrder: c.uint(33),
      newSortOrder: c.uint(32),
      newGatherPriority: c.uint(34),
      buryInterdayLearning: c.bool(29),
      fsrsWeights: c.floats(3).map(f32Json),
      fsrsParams5: c.floats(5).map(f32Json),
      fsrsParams6: c.floats(6).map(f32Json),
      desiredRetention: f32Json(c.float(37)),
      ignoreRevlogsBeforeDate: c.string(46),
      easyDaysPercentages: c.floats(4).map(f32Json),
      stopTimerOnAnswer: c.bool(38),
      secondsToShowQuestion: f32Json(c.float(41)),
      secondsToShowAnswer: f32Json(c.float(42)),
      questionAction: c.uint(36),
      answerAction: c.uint(43),
      waitForAudio: c.bool(44),
      sm2Retention: f32Json(c.float(40)),
      weightSearch: c.string(45),
      ...other,
    };
  }
  return out;
}

function config(db: Db): Json {
  const out: Json = {};
  for (const r of db.all("select key, val from config")) {
    try {
      out[str(r[0])] = parseJson(utf8.decode(r[1] as Uint8Array));
    } catch {
      // ignore unreadable values
    }
  }
  return out;
}

function tags(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.all("select tag, usn from tags")) out[str(r[0])] = num(r[1]);
  return out;
}

/** Schema-11 JSON for a schema-11 (`col` row) or schema-18 (tables) database. */
export function readCollectionJson(db: Db): Schema11Json {
  const ver = num(db.scalar("select ver from col"));
  if (ver >= 15) {
    return { conf: config(db), models: notetypes(db), decks: decks(db), dconf: deckConfigs(db), tags: tags(db) };
  }
  const r = db.first("select conf, models, decks, dconf, tags from col")!;
  const parse = (v: unknown) => {
    const s = str(v as never);
    return s ? parseJson<Json>(s) : {};
  };
  return { conf: parse(r[0]), models: parse(r[1]), decks: parse(r[2]), dconf: parse(r[3]), tags: parse(r[4]) };
}
