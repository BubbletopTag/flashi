// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Collection } from '../src/anki/collection';
import { importPackage } from '../src/anki/apkg/import';
import { bytesSource } from '../src/anki/apkg/zip';
import { MemoryMediaStore } from '../src/storage/media';

async function collection() {
  const col = await Collection.create();
  await importPackage(col, new MemoryMediaStore(), bytesSource(new Uint8Array(readFileSync('fixtures/decks/schema18-noscheduling.apkg'))));
  return { col, deckId: col.deckByName('Flashi Test::Many')!.id };
}
for (const action of ['buryCard', 'suspendCard', 'buryNote', 'suspendNote'] as const) {
  it(`undo ${action} restores the focused card without inflating counts`, async () => {
    const { col, deckId } = await collection();
    const first = col.nextCard(deckId)!;
    col[action](first.card.id);
    expect(col.nextCard(deckId)!.card.id).not.toBe(first.card.id);
    expect(col.undo()).toBeTruthy();
    const restored = col.nextCard(deckId)!;
    expect(restored.card.id).toBe(first.card.id);
    expect(restored.counts).toEqual(first.counts);
    col.db.close();
  });
}
it('answer undo restores the answer count and original review queue size', async () => {
  const { col, deckId } = await collection();
  const first = col.nextCard(deckId)!;
  col.answerCard(first.card.id, 4, 2000);
  col.nextCard(deckId);
  expect(col.undo()).toBe('Answer card');
  const restored = col.nextCard(deckId)!;
  expect(restored.card.id).toBe(first.card.id);
  expect(restored.counts).toEqual(first.counts);
  expect(Number(col.db.scalar('select count(*) from revlog'))).toBe(0);
  col.db.close();
});
