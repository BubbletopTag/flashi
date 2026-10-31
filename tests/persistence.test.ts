// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { Collection } from '../src/anki/collection';
import { AppController } from '../src/app/controller';
import { MemoryStore } from '../src/storage/store';

it('overlapping save requests commit in order without parallel writes', async () => {
  let active = 0;
  let maximum = 0;
  class SlowStore extends MemoryStore {
    override async saveCollection(bytes: Uint8Array) {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await super.saveCollection(bytes);
      active--;
    }
  }
  const store = new SlowStore();
  const col = await Collection.create();
  const app = await AppController.temporary(col, store);
  const first = app.saveNow();
  col.addDeck('Latest change');
  await Promise.all([first, app.saveNow(), app.saveNow()]);
  expect(maximum).toBe(1);
  const restored = await Collection.open((await store.loadCollection())!);
  expect(restored.deckByName('Latest change')).toBeTruthy();
  restored.db.close(); col.db.close();
});
