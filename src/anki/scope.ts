// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Collection } from './collection';
export function deckIds(col: Collection, id: number | null): number[] {
  if (id === null) return col.decksSorted().map((deck) => deck.id);
  const root = col.deck(id);
  return root ? col.decksSorted().filter((deck) => deck.id === id || deck.name.startsWith(root.name + '::')).map((deck) => deck.id) : [];
}
export function cardScope(col: Collection, id: number | null, alias = 'c'): { sql: string; bind: number[] } {
  if (id === null) return { sql: '1', bind: [] };
  const ids = deckIds(col, id);
  return { sql: ids.length ? `(${alias}.did in (${ids.map(() => '?').join(',')}) or ${alias}.odid in (${ids.map(() => '?').join(',')}))` : '0', bind: [...ids, ...ids] };
}
