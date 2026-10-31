// SPDX-License-Identifier: AGPL-3.0-or-later
// Import an Anki package (.apkg / .colpkg-style zip) into a Flashi collection.
// Merge rules follow rslib/src/import_export/package/apkg/import/*.rs
// (Copyright: Ankitects Pty Ltd and contributors): notes are matched by GUID,
// cards whose (note, template) already exist are skipped, collection-relative
// due days are shifted between collections, ids are uniquified, filtered decks
// become normal decks, and media name clashes are renamed by content hash.

import { decompress as zstdDecompress } from "fzstd";
import type { Collection } from "../collection";
import { CARD_COLUMNS, NOTE_COLUMNS, rowToCard, rowToNote } from "../collection";
import type { Json } from "../config";
import { compareDeckNames } from "../config";
import { parseJson } from "../json";
import { CardQueue, CardType, splitTags, type Card, type Note } from "../model";
import { schedTimingToday } from "../scheduler/timing";
import { Db, num, str } from "../sqlite";
import type { MediaStore } from "../../storage/media";
import { ProtoMessage } from "./protobuf";
import { readCollectionJson } from "./schema18";
import { ZipReader, type ByteSource } from "./zip";

export interface ImportProgress {
  phase: "reading" | "notes" | "cards" | "media" | "done";
  done: number;
  total: number;
}

export interface ImportResult {
  notesAdded: number;
  notesUpdated: number;
  notesSkipped: number;
  cardsAdded: number;
  decks: string[];
  mediaAdded: number;
  /** Top-level deck id of the import, for opening it afterwards. */
  firstDeckId: number | null;
}

export class ImportError extends Error {}

const utf8 = new TextDecoder();

/** The "please update" placeholder note new-style packages carry in collection.anki2. */
const STUB_TEXT = "Please update to the latest Anki version";

interface PackageInfo {
  collectionName: string;
  zstd: boolean;
  /** Media list as [zip member name, filename]. */
  media: Array<[string, string]>;
}

async function readPackageInfo(zip: ZipReader): Promise<PackageInfo> {
  let version: number;
  if (zip.has("meta")) {
    version = new ProtoMessage(await zip.read("meta")).uint(1);
    if (version === 0 || version > 3) {
      throw new ImportError("This package was made by a newer version of Anki than Flashi understands.");
    }
  } else {
    version = zip.has("collection.anki21") ? 2 : 1;
  }
  const zstd = version === 3;
  const collectionName = version === 3 ? "collection.anki21b" : version === 2 ? "collection.anki21" : "collection.anki2";
  if (!zip.has(collectionName)) {
    if (zip.has("collection.anki21b")) return readPackageInfoFor(zip, "collection.anki21b", true);
    throw new ImportError("This file doesn't contain an Anki collection. Is it an .apkg file?");
  }
  return readPackageInfoFor(zip, collectionName, zstd);
}

async function readPackageInfoFor(zip: ZipReader, collectionName: string, zstd: boolean): Promise<PackageInfo> {
  const media: Array<[string, string]> = [];
  if (zip.has("media")) {
    const raw = await zip.read("media");
    if (zstd) {
      const entries = new ProtoMessage(zstdDecompress(raw)).messages(1);
      entries.forEach((e, i) => {
        const member = e.has(255) ? String(e.uint(255)) : String(i);
        media.push([member, e.string(1)]);
      });
    } else {
      const text = utf8.decode(raw).trim();
      if (text) {
        const map = JSON.parse(text) as Record<string, string>;
        for (const [k, v] of Object.entries(map)) media.push([k, v]);
      }
    }
  }
  return { collectionName, zstd, media };
}

function sourceDaysElapsed(conf: Json, crt: number, now: number): number {
  const schedVer = typeof conf.schedVer === "number" ? conf.schedVer : 1;
  const rollover = schedVer >= 2 ? (typeof conf.rollover === "number" ? conf.rollover : 4) : null;
  const offset = typeof conf.creationOffset === "number" ? conf.creationOffset : null;
  const current = typeof conf.localOffset === "number" ? conf.localOffset : new Date(now * 1000).getTimezoneOffset();
  return schedTimingToday(crt, now, offset, current, rollover).daysElapsed;
}

function notetypeSchemaKey(m: Json): string {
  const fields = (m.flds ?? []).map((f: Json) => String(f.name)).join("\x1f");
  const templates = (m.tmpls ?? []).map((t: Json) => String(t.name)).join("\x1f");
  return `${m.type ?? 0}\x1e${fields}\x1e${templates}`;
}

async function sha1Hex(data: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", await data.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameMediaRefs(flds: string, from: string, to: string): string {
  const f = escapeRegExp(from);
  return flds
    .replace(new RegExp(`(src\\s*=\\s*["']?)${f}(?=["'\\s>])`, "gi"), `$1${to}`)
    .replace(new RegExp(`\\[sound:${f}\\]`, "g"), `[sound:${to}]`);
}

export async function importPackage(
  col: Collection,
  media: MediaStore,
  src: ByteSource,
  onProgress: (p: ImportProgress) => void = () => {},
  now = Math.floor(Date.now() / 1000),
): Promise<ImportResult> {
  onProgress({ phase: "reading", done: 0, total: 1 });
  const zip = await ZipReader.open(src);
  const info = await readPackageInfo(zip);
  let colBytes = await zip.read(info.collectionName);
  if (info.zstd) colBytes = zstdDecompress(colBytes);
  let srcDb: Db;
  try {
    srcDb = await Db.open(colBytes);
  } catch {
    throw new ImportError("The collection inside this package is damaged.");
  }
  colBytes = new Uint8Array(0);

  try {
    const json = readCollectionJson(srcDb);
    const srcCrt = num(srcDb.scalar("select crt from col"));
    const notes = srcDb.all(`select ${NOTE_COLUMNS} from notes`).map(rowToNote);
    if (
      info.collectionName === "collection.anki2" &&
      notes.length === 1 &&
      notes[0]!.flds.startsWith(STUB_TEXT)
    ) {
      throw new ImportError("This package needs a newer importer: it only contains Anki's “please update” placeholder.");
    }
    const result: ImportResult = {
      notesAdded: 0,
      notesUpdated: 0,
      notesSkipped: 0,
      cardsAdded: 0,
      decks: [],
      mediaAdded: 0,
      firstDeckId: null,
    };
    const db = col.db;

    // ----- media first, so renamed files can be rewritten in note fields
    const renames = new Map<string, string>();
    let mediaDone = 0;
    for (const [member, rawName] of info.media) {
      const name = rawName.normalize("NFC");
      onProgress({ phase: "media", done: mediaDone++, total: info.media.length });
      if (!zip.has(member) || !name || name.includes("/") || name.includes("\\")) continue;
      let bytes = await zip.read(member);
      if (info.zstd) bytes = zstdDecompress(bytes);
      const blob = new Blob([bytes as BlobPart]);
      const existing = await media.get(name);
      if (existing) {
        if (existing.size === blob.size && (await sha1Hex(existing)) === (await sha1Hex(blob))) continue;
        const hash = (await sha1Hex(blob)).slice(0, 8);
        const dot = name.lastIndexOf(".");
        const renamed = dot > 0 ? `${name.slice(0, dot)}-${hash}${name.slice(dot)}` : `${name}-${hash}`;
        renames.set(name, renamed);
        await media.put(renamed, blob);
      } else {
        await media.put(name, blob);
      }
      result.mediaAdded++;
    }

    db.transaction(() => {
      // ----- notetypes
      const notetypeMap = new Map<number, number>();
      const usedMids = new Set(notes.map((n) => n.mid));
      for (const [key, model] of Object.entries(json.models)) {
        const mid = Number(key);
        if (!usedMids.has(mid)) continue;
        const existing = col.models[key];
        if (existing && notetypeSchemaKey(existing) === notetypeSchemaKey(model)) {
          if ((model.mod ?? 0) > (existing.mod ?? 0)) col.models[key] = { ...model, usn: -1 };
          notetypeMap.set(mid, mid);
        } else if (existing) {
          let newId = Date.now();
          while (col.models[String(newId)]) newId++;
          col.models[String(newId)] = { ...model, id: newId, usn: -1 };
          notetypeMap.set(mid, newId);
        } else {
          col.models[key] = { ...model, usn: -1 };
          notetypeMap.set(mid, mid);
        }
      }

      // ----- deck configs (keep the target's existing presets)
      for (const [key, conf] of Object.entries(json.dconf)) {
        if (!col.dconf[key]) col.dconf[key] = { ...conf, usn: -1 };
      }

      // ----- decks, matched by name
      const deckMap = new Map<number, number>();
      const srcDecks = Object.values(json.decks).sort((a: Json, b: Json) => compareDeckNames(String(a.name), String(b.name)));
      const cardDeckIds = new Set<number>();
      for (const r of srcDb.all("select distinct did from cards union select distinct odid from cards where odid != 0")) {
        cardDeckIds.add(num(r[0]));
      }
      for (const deck of srcDecks as Json[]) {
        const srcId = Number(deck.id);
        const name = String(deck.name);
        // Every deck in the package is imported, except an unused Default deck.
        if (srcId === 1 && !cardDeckIds.has(1)) continue;
        const existing = col.deckByName(name);
        if (existing) {
          deckMap.set(srcId, existing.id);
          continue;
        }
        let newId = srcId;
        if (col.decksJson[String(newId)]) {
          newId = Date.now();
          while (col.decksJson[String(newId)]) newId++;
        }
        const copy: Json = { ...deck, id: newId, usn: -1 };
        if (copy.dyn) {
          // Filtered decks become normal decks (as Anki does when it can't keep them).
          for (const k of ["resched", "terms", "separate", "delays", "previewDelay", "previewAgainSecs", "previewHardSecs", "previewGoodSecs"]) delete copy[k];
          Object.assign(copy, { dyn: 0, conf: 1, extendNew: 0, extendRev: 0, desc: copy.desc ?? "" });
        }
        if (!col.dconf[String(copy.conf)]) copy.conf = 1;
        col.decksJson[String(newId)] = copy;
        deckMap.set(srcId, newId);
        result.decks.push(name);
      }
      // Parents of imported decks must exist.
      for (const name of result.decks) col.addDeck(name, now);

      // ----- notes, matched by GUID
      const noteMap = new Map<number, number>();
      const existingGuids = new Map<string, { id: number; mid: number; mod: number }>();
      for (const r of db.all("select guid, id, mid, mod from notes")) {
        existingGuids.set(str(r[0]), { id: num(r[1]), mid: num(r[2]), mod: num(r[3]) });
      }
      const existingNoteIds = new Set(db.all("select id from notes").map((r) => num(r[0])));
      const newTags = new Set<string>();
      let i = 0;
      for (const note of notes) {
        onProgress({ phase: "notes", done: i++, total: notes.length });
        const mid = notetypeMap.get(note.mid);
        if (mid === undefined) {
          result.notesSkipped++;
          continue;
        }
        let flds = note.flds;
        for (const [from, to] of renames) flds = renameMediaRefs(flds, from, to);
        const existing = existingGuids.get(note.guid);
        if (existing) {
          noteMap.set(note.id, existing.id);
          if (existing.mid === mid && note.mod > existing.mod) {
            db.exec("update notes set flds = ?, sfld = ?, csum = ?, tags = ?, mod = ?, usn = -1 where id = ?", [
              flds, note.sfld, note.csum, note.tags, note.mod, existing.id,
            ]);
            result.notesUpdated++;
          } else {
            result.notesSkipped++;
          }
          continue;
        }
        let id = note.id;
        while (existingNoteIds.has(id)) id++;
        existingNoteIds.add(id);
        const added: Note = { ...note, id, mid, flds, usn: -1 };
        db.exec(`insert into notes (${NOTE_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          added.id, added.guid, added.mid, added.mod, added.usn, added.tags, added.flds, added.sfld, added.csum, added.flags, added.data,
        ]);
        for (const t of splitTags(note.tags)) newTags.add(t);
        noteMap.set(note.id, id);
        result.notesAdded++;
      }
      for (const t of newTags) if (!(t in col.tagsJson)) col.tagsJson[t] = -1;

      // ----- cards
      const srcDays = sourceDaysElapsed(json.conf, srcCrt, now);
      const delta = srcDays - col.timing(now).daysElapsed;
      const existingOrds = new Set(db.all("select nid, ord from cards").map((r) => `${num(r[0])}:${num(r[1])}`));
      const existingCardIds = new Set(db.all("select id from cards").map((r) => num(r[0])));
      const cardIdMap = new Map<number, number>();
      const cards = srcDb.all(`select ${CARD_COLUMNS} from cards`).map(rowToCard);
      let nextPos = typeof col.conf.nextPos === "number" ? col.conf.nextPos : 1;
      i = 0;
      for (const original of cards) {
        onProgress({ phase: "cards", done: i++, total: cards.length });
        const nid = noteMap.get(original.nid);
        if (nid === undefined || existingOrds.has(`${nid}:${original.ord}`)) continue;
        const card: Card = { ...original, nid, usn: -1 };
        restoreFromFilteredDeck(card, json.decks);
        card.did = deckMap.get(card.did) ?? deckMap.get(1) ?? 1;
        if (!col.decksJson[String(card.did)]) card.did = 1;
        card.odid = card.odid ? (deckMap.get(card.odid) ?? 0) : 0;
        if (card.queue === CardQueue.Review || card.queue === CardQueue.DayLearn || card.type === CardType.Review) {
          card.due -= delta;
        }
        if (card.type === CardType.Review && card.odue !== 0) card.odue -= delta;
        if (card.type === CardType.New) nextPos = Math.max(nextPos, card.due + 1);
        const oldId = card.id;
        while (existingCardIds.has(card.id)) card.id += 999;
        existingCardIds.add(card.id);
        existingOrds.add(`${nid}:${card.ord}`);
        cardIdMap.set(oldId, card.id);
        db.exec(`insert into cards (${CARD_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          card.id, card.nid, card.did, card.ord, card.mod, card.usn, card.type, card.queue, card.due, card.ivl,
          card.factor, card.reps, card.lapses, card.left, card.odue, card.odid, card.flags, card.data,
        ]);
        result.cardsAdded++;
        if (result.firstDeckId === null) result.firstDeckId = card.did;
      }
      col.conf.nextPos = nextPos;

      // ----- review history
      srcDb.each("select id, cid, usn, ease, ivl, lastIvl, factor, time, type from revlog", undefined, (r) => {
        const cid = cardIdMap.get(num(r[1]));
        if (cid === undefined) return;
        db.exec("insert or ignore into revlog values (?, ?, -1, ?, ?, ?, ?, ?, ?)", [
          num(r[0]), cid, num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[7]), num(r[8]),
        ]);
      });
    });

    if (result.firstDeckId !== null) {
      const deck = col.deck(result.firstDeckId);
      const top = deck ? col.deckByName(deck.name.split("::")[0]!) : null;
      if (top) result.firstDeckId = top.id;
    }
    col.markJsonDirty();
    col.invalidateQueue();
    onProgress({ phase: "done", done: 1, total: 1 });
    return result;
  } finally {
    srcDb.close();
  }
}

/** Cards exported from a filtered deck go back to their home deck. */
function restoreFromFilteredDeck(card: Card, decks: Record<string, Json>): void {
  if (!card.odid) return;
  const home = decks[String(card.odid)];
  if (!home || home.dyn) {
    card.odid = 0;
    card.odue = 0;
    return;
  }
  card.did = card.odid;
  if (card.odue) card.due = card.odue;
  card.odid = 0;
  card.odue = 0;
  if (card.queue < 0) return;
  if (card.type === CardType.Learn || card.type === CardType.Relearn) {
    card.queue = card.due > 1_000_000_000 ? CardQueue.Learn : CardQueue.DayLearn;
  } else if (card.type === CardType.New) card.queue = CardQueue.New;
  else card.queue = CardQueue.Review;
}

/** Parse a schema-11 JSON blob, tolerating empty strings. */
export function parseColJson(s: string): Json {
  return s ? parseJson(s) : {};
}
