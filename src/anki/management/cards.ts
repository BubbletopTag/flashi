// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Collection } from '../collection';
import { nowSecs, cardToRow, CARD_COLUMNS } from '../collection';
import { num } from '../sqlite';
import type { Card } from '../model';

export type CardAction = 'suspend' | 'unsuspend' | 'bury' | 'unbury' | 'forget';
function originalQueue(card: Card): number { return card.type === 0 ? 0 : card.type === 2 ? 2 : card.due > 1_000_000_000 ? 1 : 3; }
export function changeCards(col: Collection, ids: number[], action: CardAction | { deck: number } | { flag: number } | { due: number }): number {
  const previous: Card[] = [];
  if (typeof action === 'object' && 'deck' in action && (!col.deck(action.deck) || col.deck(action.deck)!.filtered)) throw new Error('Choose a normal destination deck.');
  if (typeof action === 'object' && 'due' in action && (!Number.isInteger(action.due) || action.due < -36500 || action.due > 36500)) throw new Error('Enter a whole number of days between -36500 and 36500.');
  col.db.transaction(() => {
    for (const id of ids) {
      const card = col.getCard(id); if (!card) continue;
      previous.push(card);
      const changed = { ...card, mod: nowSecs(), usn: -1 };
      if (action === 'suspend') changed.queue = -1;
      else if (action === 'bury') { if (changed.queue !== -1) changed.queue = -3; }
      else if (action === 'unsuspend' || action === 'unbury') { if (action === 'unsuspend' ? changed.queue === -1 : changed.queue < -1) changed.queue = originalQueue(changed); }
      else if (action === 'forget') {
        const position = Number(col.conf.nextPos ?? 1); col.conf.nextPos = position + 1;
        Object.assign(changed, { type: 0, queue: 0, due: position, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odid: 0, odue: 0, data: '' });
      } else if (typeof action === 'object') {
        if ('deck' in action) { changed.did = action.deck; if (changed.odid) { changed.due = changed.odue; changed.odid = 0; changed.odue = 0; } }
        else if ('flag' in action) { if (action.flag < 0 || action.flag > 7) throw new Error('Choose a valid flag.'); changed.flags = (card.flags & ~7) | action.flag; }
        else if ('due' in action) { changed.type = 2; changed.queue = 2; changed.due = col.timing().daysElapsed + action.due; changed.ivl = Math.max(1, Math.abs(action.due)); changed.factor ||= 2500; changed.left = 0; changed.odid = 0; changed.odue = 0; }
      }
      col.updateCard(changed);
    }
  });
  if (previous.length) col.registerUndo(typeof action === 'string' ? `${action[0]!.toUpperCase()}${action.slice(1)} cards` : 'Change cards', () => {
    for (const card of previous) col.db.exec(`insert or replace into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`, cardToRow(card));
  });
  col.markJsonDirty(); col.invalidateQueue(); return previous.length;
}
export function cardHistory(col: Collection, id: number) {
  return col.db.all('select id,ease,ivl,lastIvl,factor,time,type from revlog where cid=? order by id desc', [id]).map((row) => ({ id:num(row[0]), rating:num(row[1]), interval:num(row[2]), previousInterval:num(row[3]), factor:num(row[4]), time:num(row[5]), type:num(row[6]) }));
}
