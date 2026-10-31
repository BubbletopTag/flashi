// SPDX-License-Identifier: AGPL-3.0-or-later
// Export the whole collection as an .apkg in the layout current Anki writes
// with "Support older Anki versions" ticked (rslib/src/import_export/package/
// colpkg/export.rs, Copyright: Ankitects Pty Ltd and contributors):
//   meta               protobuf PackageMetadata { version: LEGACY_2 }  (stored)
//   collection.anki21  schema-11 SQLite                               (deflate)
//   collection.anki2   "please update" placeholder collection         (stored)
//   0, 1, …            media files                                    (stored)
//   media              JSON {"0": "name", …}                          (stored)

import defaults from "../defaults.json";
import { CARD_COLUMNS, SCHEMA11_SQL, type Collection } from "../collection";
import type { Json } from "../config";
import { stringifyJson } from "../json";
import { Db } from "../sqlite";
import type { MediaStore } from "../../storage/media";
import { ZipWriter } from "./zip";

export interface ExportProgress {
  phase: "collection" | "media" | "zip";
  done: number;
  total: number;
}

const META_LEGACY_2 = new Uint8Array([0x08, 0x02]);
const STUB_NOTE = "Please update to the latest Anki version, then import the .colpkg/.apkg file again.";

/** The tiny schema-11 collection Anki puts in collection.anki2 for very old clients. */
export async function placeholderCollection(crt: number): Promise<Uint8Array> {
  const db = await Db.open();
  try {
    db.exec("pragma page_size = 512");
    db.exec(SCHEMA11_SQL);
    const d = defaults as unknown as Json;
    const keyed = (list: Json[]) => Object.fromEntries(list.map((x: Json) => [String(x.id), x]));
    const models = keyed(d.models);
    const basic = d.models.find((m: Json) => m.name === "Basic");
    db.exec("insert into col values (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)", [
      crt, Date.now(), Date.now(), stringifyJson(d.conf), stringifyJson(models), stringifyJson(keyed(d.decks)),
      stringifyJson(keyed(d.dconf)), "{}",
    ]);
    const id = Date.now();
    db.exec("insert into notes values (?, ?, ?, ?, -1, '', ?, ?, 0, 0, '')", [
      id, "flashi-placeholder", basic.id, Math.floor(id / 1000), `${STUB_NOTE}\x1f`, STUB_NOTE,
    ]);
    db.exec(`insert into cards (${CARD_COLUMNS}) values (?, ?, 1, 0, ?, -1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, '')`, [
      id + 1, id, Math.floor(id / 1000),
    ]);
    db.exec("vacuum");
    return db.export();
  } finally {
    db.close();
  }
}

/** Media files referenced by notes or templates (Anki exports only these). */
function referencedMedia(col: Collection, available: Set<string>): string[] {
  const used = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/<img[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/gi)) used.add(decodeURIComponentSafe(m[1]!));
    for (const m of text.matchAll(/\[sound:([^\]]+)\]/g)) used.add(m[1]!);
    for (const m of text.matchAll(/<(?:audio|video|source|object)[^>]*?\s(?:src|data)\s*=\s*["']?([^"'\s>]+)/gi)) {
      used.add(decodeURIComponentSafe(m[1]!));
    }
  };
  col.db.each("select flds from notes", undefined, (r) => {
    scan(String(r[0] ?? ""));
  });
  for (const name of available) {
    // Files starting with "_" are used by templates/styling and always kept.
    if (name.startsWith("_")) used.add(name);
  }
  return [...used].filter((n) => available.has(n)).sort();
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function exportPackage(
  col: Collection,
  media: MediaStore,
  onProgress: (p: ExportProgress) => void = () => {},
): Promise<Blob> {
  onProgress({ phase: "collection", done: 0, total: 1 });
  const bytes = col.serialize();
  const zip = new ZipWriter();
  zip.addStored("meta", META_LEGACY_2);
  zip.addDeflated("collection.anki21", bytes);
  zip.addStored("collection.anki2", await placeholderCollection(col.crt));

  const names = referencedMedia(col, new Set(await media.list()));
  const map: Record<string, string> = {};
  let index = 0;
  for (const name of names) {
    onProgress({ phase: "media", done: index, total: names.length });
    const blob = await media.get(name);
    if (!blob) continue;
    zip.addStored(String(index), new Uint8Array(await blob.arrayBuffer()));
    map[String(index)] = name;
    index++;
  }
  zip.addStored("media", new TextEncoder().encode(JSON.stringify(map)));
  onProgress({ phase: "zip", done: 0, total: 1 });
  return zip.finish();
}
