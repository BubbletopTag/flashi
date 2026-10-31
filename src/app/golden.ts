// SPDX-License-Identifier: AGPL-3.0-or-later
// This module and the fixture are removed from production builds.
import fixture from '../../fixtures/golden-fixture.json';
import { Collection, cardToRow } from '../anki/collection';
import { MemoryStore } from '../storage/store';
import { AppController } from './controller';

export async function goldenApp(): Promise<AppController> {
  const col = await Collection.create(Math.floor(Date.parse(fixture.now) / 1000));
  const screen = new URLSearchParams(location.search).get('screen') ?? 'decks';
  if (!['empty', 'fab'].includes(screen)) {
    const decks = new Map(fixture.decks.map((name) => [name, col.addDeck(name)]));
    let position = 1;
    for (const note of fixture.notes) {
      const model = Object.values(col.models).find((model) => model.name === note.notetype)!;
      col.db.exec('insert into notes values (?, ?, ?, 0, -1, ?, ?, ?, 0, 0, ?)', [note.id, `golden-${note.id}`, Number(model.id), '', note.fields.join('\x1f'), note.fields[0]!, '']);
      const card = { id: note.cardId, nid: note.id, did: decks.get(note.deck)!, ord: 0, mod: 0, usn: -1, type: 0, queue: 0, due: position++, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' };
      col.db.exec(`insert into cards values (${Array(18).fill('?').join(',')})`, cardToRow(card));
    }
  }
  const store = new MemoryStore();
  await store.setMeta({ prefs: { showDeckTitle: false, showEta: false, autoplay: false } });
  return AppController.temporary(col, store);
}
