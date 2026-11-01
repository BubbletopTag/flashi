// SPDX-License-Identifier: AGPL-3.0-or-later
// Anki-style browser search: implicit AND, OR, groups, negation, quoted terms,
// fields/tags/decks, states and common numeric/rated/added properties.
import type { Collection } from '../collection';
import type { SqlValue } from '../sqlite';
import { num, str } from '../sqlite';
import { stripHtml } from '../template/text';

export interface SearchFilter { sql: string; bind: SqlValue[] }
function tokens(input: string): string[] {
  const out: string[] = []; let token = ''; let quoted = false; let escape = false;
  for (const ch of input) {
    if (escape) { token += ch; escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && (ch === '(' || ch === ')' || /\s/.test(ch))) {
      if (token) { out.push(token); token = ''; }
      if (ch === '(' || ch === ')') out.push(ch);
    } else token += ch;
  }
  if (quoted) throw new Error('Close the quotation mark in your search.');
  if (escape) token += '\\';
  if (token) out.push(token);
  return out;
}
const like = (value: string) => value.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%').toLowerCase();
export function searchFilter(col: Collection, query: string): SearchFilter {
  const parts = tokens(query.trim()); let position = 0;
  const bind: SqlValue[] = [];
  const param = (value: SqlValue) => { bind.push(value); return '?'; };
  const textMatch = (expression: string, value: string, whole = false) => `flashi_lower(${expression}) like ${param(whole ? like(value) : `%${like(value)}%`)} escape '\\'`;
  const idMatch = (column: string, ids: number[]) => ids.length ? `${column} in (${ids.map((id) => param(id)).join(',')})` : '0';
  const term = (raw: string): string => {
    if (raw.startsWith('-') && raw.length > 1) return `not (${term(raw.slice(1))})`;
    const colon = raw.indexOf(':');
    if (colon < 0) return textMatch('flashi_text(n.flds)', raw);
    const key = raw.slice(0, colon).toLowerCase(); const value = raw.slice(colon + 1);
    if (key === 'deck') {
      if (value === '*') return '1';
      if (value.toLowerCase() === 'current') return term(`deck:${col.deck(col.currentDeckId())?.name ?? 'Default'}`);
      const pattern = new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '(?:::.*)?$', 'i');
      const ids = col.decksSorted().filter((deck) => pattern.test(deck.name)).map((deck) => deck.id);
      return `(${idMatch('c.did', ids)} or ${idMatch('c.odid', ids)})`;
    }
    if (key === 'tag') return value.toLowerCase() === 'none' ? "trim(n.tags)=''" : `(${textMatch('n.tags', ` ${value} `)} or ${textMatch('n.tags', ` ${value}::* `)})`;
    if (key === 'note') return idMatch('n.mid', Object.values(col.models).filter((model) => new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(model.name)).map((model) => Number(model.id)));
    if (key === 'nid' || key === 'cid') {
      const ids = value.split(',').map(Number); if (ids.some((id) => !Number.isSafeInteger(id))) throw new Error('Use numeric card or note IDs.');
      return idMatch(key === 'nid' ? 'n.id' : 'c.id', ids);
    }
    if (key === 'flag') { const flag = Number(value); if (!Number.isInteger(flag) || flag < 0 || flag > 7) throw new Error('Flags range from 0 to 7.'); return `(c.flags & 7)=${param(flag)}`; }
    if (key === 'is') {
      const now = Math.floor(Date.now()/1000); const today = col.timing(now).daysElapsed;
      const choices: Record<string,string> = { new: 'c.type=0', review: 'c.type in (2,3)', learn: 'c.type in (1,3)', suspended: 'c.queue=-1', buried: 'c.queue in (-2,-3)', due: `((c.queue in (2,3) and c.due<=${today}) or (c.queue=1 and c.due<=${now}))`, marked: "flashi_lower(n.tags) like '% marked %'", young: 'c.type=2 and c.ivl<21', mature: 'c.type=2 and c.ivl>=21' };
      if (!choices[value.toLowerCase()]) throw new Error(`Unknown card state: ${value}`);
      return choices[value.toLowerCase()]!;
    }
    if (key === 'added' || key === 'edited') {
      const days = Number(value); if (!(days > 0)) throw new Error('Use a positive number of days.');
      const cutoff = col.timing().nextDayAt - days * 86400;
      return key === 'added' ? `n.id>=${param(cutoff * 1000)}` : `n.mod>=${param(cutoff)}`;
    }
    if (key === 'rated') {
      const [days, ease] = value.split(':').map(Number);
      if (!(days! > 0) || (ease !== undefined && !(ease >= 1 && ease <= 4))) throw new Error('Use rated:days or rated:days:1-4.');
      return `exists(select 1 from revlog r where r.cid=c.id and r.id>=${param((col.timing().nextDayAt - days! * 86400)*1000)}${ease === undefined ? '' : ` and r.ease=${param(ease)}`})`;
    }
    if (key === 'prop') {
      const match = /^(ivl|reps|lapses|ease|due)(<=|>=|!=|=|<|>)(-?\d+(?:\.\d+)?)$/.exec(value);
      if (!match) throw new Error('Use prop:ivl>=21, prop:reps>5, prop:lapses>2, prop:ease<2.5 or prop:due<=0.');
      const column = match[1] === 'ease' ? 'c.factor/1000.0' : match[1] === 'due' ? `c.due-${col.timing().daysElapsed}` : `c.${match[1]}`;
      const comparison = `${column}${match[2]}${param(Number(match[3]))}`;
      return match[1] === 'due' ? `(c.queue in (2,3) and ${comparison})` : comparison;
    }
    const fields: string[] = [];
    for (const model of Object.values(col.models)) {
      const index = model.flds.findIndex((field: { name: string }) => field.name.toLowerCase() === key);
      if (index >= 0) fields.push(`(n.mid=${param(Number(model.id))} and ${textMatch(`flashi_text(flashi_field(n.flds,${index}))`, value)})`);
    }
    if (fields.length) return `(${fields.join(' or ')})`;
    throw new Error(`Unknown search filter: ${key}`);
  };
  function factor(): string {
    const value = parts[position++];
    if (!value || value === ')') throw new Error('A search term is missing.');
    if (value === '-' && parts[position] === '(') return `not (${factor()})`;
    if (value === '(') { const inner = or(); if (parts[position++] !== ')') throw new Error('Close the search group with ).'); return `(${inner})`; }
    return term(value);
  }
  function and(): string {
    const out = [factor()];
    while (position < parts.length && parts[position] !== ')' && parts[position]?.toUpperCase() !== 'OR') { if (parts[position]?.toUpperCase() === 'AND') position++; out.push(factor()); }
    return out.map((value) => `(${value})`).join(' and ');
  }
  function or(): string { const out = [and()]; while (parts[position]?.toUpperCase() === 'OR') { position++; out.push(and()); } return out.map((value) => `(${value})`).join(' or '); }
  const sql = parts.length ? or() : '1';
  if (position !== parts.length) throw new Error('Unexpected closing parenthesis.');
  return { sql, bind };
}
export interface BrowserRow { id: number; noteId: number; modelId: number; question: string; answer: string; deckId: number; queue: number; type: number; interval: number; due: number; reps: number; lapses: number; flag: number; tags: string; ord: number }
export type BrowserSort = 'question' | 'due' | 'created' | 'interval' | 'reps' | 'lapses';
export function browse(col: Collection, query = '', sort: BrowserSort = 'question', descending = false, offset = 0, limit = 100): { total: number; rows: BrowserRow[] } {
  const filter = searchFilter(col, query);
  const columns = { question: 'n.sfld collate unicase', due: 'c.type,c.due', created: 'n.id', interval: 'c.ivl', reps: 'c.reps', lapses: 'c.lapses' };
  const total = num(col.db.scalar(`select count(*) from cards c join notes n on n.id=c.nid where ${filter.sql}`, filter.bind));
  const order = columns[sort].split(',').map((column) => `${column} ${descending ? 'desc' : 'asc'}`).join(',');
  const rows = col.db.all(`select c.id,n.id,n.mid,n.flds,c.did,c.queue,c.type,c.ivl,c.due,c.reps,c.lapses,c.flags,n.tags,c.ord from cards c join notes n on n.id=c.nid where ${filter.sql} order by ${order},c.id limit ? offset ?`, [...filter.bind,limit,offset]).map((row) => {
    const fields = str(row[3]).split('\x1f');
    return { id:num(row[0]), noteId:num(row[1]), modelId:num(row[2]), question:stripHtml(fields[0]??'').replace(/\[sound:[^\]]+\]/g,'♪'), answer:stripHtml(fields[1]??''), deckId:num(row[4]), queue:num(row[5]), type:num(row[6]), interval:num(row[7]), due:num(row[8]), reps:num(row[9]), lapses:num(row[10]), flag:num(row[11]) & 7, tags:str(row[12]), ord:num(row[13]) };
  });
  return { total, rows };
}
