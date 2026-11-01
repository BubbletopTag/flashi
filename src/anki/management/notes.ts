// SPDX-License-Identifier: AGPL-3.0-or-later
// Note/card generation follows rslib/src/notetype/cardgen.rs and notes/mod.rs
// (Ankitects Pty Ltd and contributors). Editing never removes scheduled cards
// automatically when a field/cloze becomes empty; the empty-card tool handles it.
import { CARD_COLUMNS, NOTE_COLUMNS, cardToRow, nowSecs, type Collection } from '../collection';
import type { Card, Note } from '../model';
import { joinTags, splitTags } from '../model';
import type { Json } from '../config';
import { sha1Hex } from '../sha1';
import { sha1Fallback } from '../sha1';
import { clozeNumbersInString } from '../template/cloze';
import { renderCard } from '../template/template';
import { fieldIsEmpty, stripHtml } from '../template/text';
import { num } from '../sqlite';

export function uniqueId(col: Collection, table: 'notes' | 'cards'): number {
  let id = Date.now(); while (col.db.scalar(`select 1 from ${table} where id=?`, [id])) id++; return id;
}
export function mediaText(html: string): string {
  return stripHtml(html.replace(/<(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_match, a, b, c) => ` ${a ?? b ?? c ?? ''} `));
}
export function canonicalTags(tags: string[] | string): string[] {
  const items = typeof tags === 'string' ? splitTags(tags) : tags;
  const seen = new Set<string>();
  return items.map((tag) => tag.trim().normalize('NFC')).filter((tag) => {
    if (!tag || /\s/.test(tag) || seen.has(tag.toLowerCase())) return false;
    seen.add(tag.toLowerCase()); return true;
  }).sort((a, b) => a.localeCompare(b));
}
export function requiredOrdinals(model: Json, fields: string[], tags: string[] = []): number[] {
  if (model.type === 1) {
    return [...new Set(fields.flatMap((field) => [...clozeNumbersInString(field)]).map((ord) => Math.min(499, ord - 1)))].sort((a,b) => a-b);
  }
  const map = new Map<string,string>((model.flds as Json[]).map((field, i) => [String(field.name), fields[i] ?? '']));
  for (const [name, value] of [['Tags', tags.join(' ')], ['Deck', 'Deck'], ['Subdeck', 'Deck'], ['Type', model.name], ['Card', 'Card'], ['CardFlag', 'flag0'], ['CardID', '1']]) if (!map.has(name)) map.set(name, value);
  return (model.tmpls as Json[]).flatMap((template, i) => {
    const ord = Number(template.ord ?? i);
    return renderCard(String(template.qfmt), String(template.afmt), map, ord, false).isEmpty ? [] : [ord];
  });
}
function generateCards(col: Collection, note: Note, model: Json, fields: string[], deckId: number): number {
  const existing = col.db.all(`select ${CARD_COLUMNS} from cards where nid=?`, [note.id]);
  const ords = new Set(existing.map((row) => num(row[3])));
  const needed = requiredOrdinals(model, fields, splitTags(note.tags)).filter((ord) => !ords.has(ord));
  if (!existing.length && !needed.length) needed.push(0);
  const due = existing.find((row) => num(row[7]) === 0)?.[8] ?? Number(col.conf.nextPos ?? 1);
  if (!existing.length) col.conf.nextPos = Number(due) + 1;
  for (const ord of needed) {
    const template = model.type === 1 ? model.tmpls[0] : model.tmpls.find((template: Json) => Number(template.ord) === ord);
    const override = Number(template?.did ?? 0);
    const did = override && col.deck(override) && !col.deck(override)!.filtered ? override : deckId;
    const card: Card = { id: uniqueId(col, 'cards'), nid: note.id, did, ord, mod: nowSecs(), usn: -1, type: 0, queue: 0, due: Number(due), ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' };
    col.db.exec(`insert into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`, cardToRow(card));
  }
  return needed.length;
}
export interface NoteInput { id?: number; modelId: number; deckId: number; fields: string[]; tags: string[] | string }
export async function saveNote(col: Collection, input: NoteInput): Promise<{ id: number; added: number; duplicate: boolean }> {
  const model = col.model(input.modelId);
  if (!model || !Array.isArray(model.flds) || !Array.isArray(model.tmpls)) throw new Error('This note type is unavailable.');
  if (!col.deck(input.deckId) || col.deck(input.deckId)!.filtered) throw new Error('Choose a normal deck for this note.');
  if (input.fields.length !== model.flds.length) throw new Error('The fields no longer match this note type. Reopen the editor.');
  const fields = input.fields.map((field) => field.replace(/\x1f/g, '').normalize('NFC'));
  if (!input.id && fieldIsEmpty(fields[0] ?? '')) throw new Error('The first field must not be empty.');
  if (!input.id && model.type === 1 && !requiredOrdinals(model, fields).length) throw new Error('Add a cloze deletion, such as {{c1::answer}}, before saving.');
  const tags = canonicalTags(input.tags);
  const first = mediaText(fields[0]!);
  const checksum = parseInt((await sha1Hex(new Blob([first]))).slice(0, 8), 16);
  const id = input.id ?? uniqueId(col, 'notes');
  const previous = input.id ? col.getNote(id) : null;
  const oldCards = col.db.all(`select ${CARD_COLUMNS} from cards where nid=?`, [id]);
  if (input.id && !previous) throw new Error('That note no longer exists.');
  if (previous && previous.mid !== input.modelId) throw new Error('Use Change note type to convert an existing note.');
  const duplicate = !!col.db.scalar('select 1 from notes where mid=? and csum=? and id!=?', [input.modelId, checksum, id]);
  const random = new Uint8Array(8); crypto.getRandomValues(random);
  const guid = previous?.guid ?? Array.from(random, (byte) => byte.toString(36).padStart(2, '0')).join('');
  const note: Note = { id, guid, mid: input.modelId, mod: nowSecs(), usn: -1, tags: joinTags(tags), flds: fields.join('\x1f'), sfld: mediaText(fields[Number(model.sortf ?? 0)] ?? ''), csum: checksum, flags: previous?.flags ?? 0, data: previous?.data ?? '' };
  let added = 0;
  col.db.transaction(() => {
    col.db.exec(`insert or replace into notes (${NOTE_COLUMNS}) values (${Array(11).fill('?').join(',')})`, [note.id,note.guid,note.mid,note.mod,note.usn,note.tags,note.flds,note.sfld,note.csum,note.flags,note.data]);
    // Existing card state is retained when a note is moved to another deck.
    if (previous) col.db.exec('update cards set did=?, odid=0, odue=0, mod=?,usn=-1 where nid=? and odid=0 and did!=?', [input.deckId, note.mod, id, input.deckId]);
    added = generateCards(col, note, model, fields, input.deckId);
  });
  for (const tag of tags) col.tagsJson[tag] = -1;
  model.did = input.deckId;
  col.conf.curModel = input.modelId;
  col.markJsonDirty(); col.invalidateQueue();
  col.registerUndo(previous ? 'Edit note' : 'Add note', () => {
    col.db.exec('delete from cards where nid=?', [id]);
    if (previous) col.db.exec(`insert or replace into notes (${NOTE_COLUMNS}) values (${Array(11).fill('?').join(',')})`, [previous.id,previous.guid,previous.mid,previous.mod,previous.usn,previous.tags,previous.flds,previous.sfld,previous.csum,previous.flags,previous.data]);
    else col.db.exec('delete from notes where id=?', [id]);
    for (const row of oldCards) col.db.exec(`insert or replace into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`, row);
  });
  return { id, added, duplicate };
}
export function noteDuplicates(col: Collection, modelId: number, first: string, except = 0): number[] {
  const text = mediaText(first);
  const checksum = parseInt(sha1Fallback(new TextEncoder().encode(text)).slice(0, 8), 16);
  return col.db.all('select id,flds from notes where mid=? and csum=? and id!=?', [modelId, checksum, except]).filter((row) => mediaText(String(row[1]).split('\x1f')[0] ?? '') === text).map((row) => num(row[0]));
}
export function deleteNotes(col: Collection, ids: number[]): void {
  if (!ids.length) return;
  const notes = ids.flatMap((id) => col.db.all(`select ${NOTE_COLUMNS} from notes where id=?`, [id]));
  const cards = ids.flatMap((id) => col.db.all(`select ${CARD_COLUMNS} from cards where nid=?`, [id]));
  col.db.transaction(() => {
    for (const id of ids) {
      for (const row of col.db.all('select id from cards where nid=?', [id])) col.db.exec('insert into graves values (-1,?,0)', [num(row[0])]);
      col.db.exec('insert into graves values (-1,?,1)', [id]);
      col.db.exec('delete from cards where nid=?', [id]);
      col.db.exec('delete from notes where id=?', [id]);
    }
  });
  col.markJsonDirty(); col.invalidateQueue();
  col.registerUndo('Delete notes', () => {
    for (const row of notes) { col.db.exec(`insert or replace into notes (${NOTE_COLUMNS}) values (${Array(11).fill('?').join(',')})`, row); col.db.exec('delete from graves where oid=? and type=1', [num(row[0])]); }
    for (const row of cards) { col.db.exec(`insert or replace into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`, row); col.db.exec('delete from graves where oid=? and type=0', [num(row[0])]); }
  });
}
export function setNoteTags(col: Collection, ids: number[], add: string[], remove: string[] = []): void {
  const previous = ids.map((id) => col.getNote(id)).filter((note): note is Note => !!note);
  for (const id of ids) {
    const note = col.getNote(id); if (!note) continue;
    const tags = canonicalTags([...splitTags(note.tags).filter((tag) => !remove.some((value) => tag.toLowerCase() === value.toLowerCase())), ...add]);
    col.db.exec('update notes set tags=?,mod=?,usn=-1 where id=?', [joinTags(tags), nowSecs(), id]);
    for (const tag of tags) col.tagsJson[tag] = -1;
  }
  col.markJsonDirty(); col.invalidateQueue();
  col.registerUndo('Edit tags', () => { for (const note of previous) col.db.exec('update notes set tags=?,mod=?,usn=? where id=?', [note.tags,note.mod,note.usn,note.id]); });
}
