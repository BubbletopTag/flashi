// SPDX-License-Identifier: AGPL-3.0-or-later
// Deck-list counts and study-queue order compared live with official Anki
// (skipped when the `anki` Python package is not installed).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Collection } from "../src/anki/collection";
import { importPackage } from "../src/anki/apkg/import";
import { bytesSource } from "../src/anki/apkg/zip";
import type { DeckTreeNode } from "../src/anki/scheduler/deckTree";
import { MemoryMediaStore } from "../src/storage/media";

const python = process.env.FLASHI_ANKI_PYTHON ?? "python3";
let haveAnki = false;
try {
  execFileSync(python, ["-c", "import anki"], { stdio: "ignore" });
  haveAnki = true;
} catch {
  haveAnki = false;
}

const fixturePath = join(__dirname, "..", "fixtures", "decks", "legacy-anki21.apkg");

function anki(deck: string, answers = "") {
  return JSON.parse(
    execFileSync(python, [join(__dirname, "..", "scripts", "queue-golden.py"), fixturePath, deck, answers], {
      encoding: "utf8",
    }),
  );
}

async function flashi(deck: string, answers = "") {
  const col = await Collection.create();
  await importPackage(col, new MemoryMediaStore(), bytesSource(new Uint8Array(readFileSync(fixturePath))));
  const did = col.deckByName(deck)!.id;
  for (const ch of answers) {
    const next = col.nextCard(did)!;
    col.answerCard(next.card.id, Number(ch), 1000);
  }
  const counts: Record<string, number[]> = {};
  const walk = (node: DeckTreeNode) => {
    for (const c of node.children) {
      counts[c.fullName] = [c.newCount, c.learnCount, c.reviewCount];
      walk(c);
    }
  };
  walk(col.deckTree());
  const queue: Array<[string, number]> = [];
  const q = col.studyQueue(did);
  const ids = [
    ...q.intradayLearning.filter((e) => e.due <= q.currentLearningCutoff).map((e) => e.id),
    ...q.main.map((e) => e.id),
    ...q.intradayLearning.filter((e) => e.due > q.currentLearningCutoff && e.due <= q.currentLearningCutoff + q.learnAheadSecs).map((e) => e.id),
  ];
  for (const id of ids) {
    const card = col.getCard(id)!;
    queue.push([col.getNote(card.nid)!.guid, card.ord]);
  }
  const c = q.getCounts(Math.floor(Date.now() / 1000));
  return { counts, queue, queueCounts: [c.new, c.learning, c.review] };
}

describe.skipIf(!haveAnki)("study queue matches official Anki", () => {
  for (const [deck, answers] of [
    ["Flashi Test", ""],
    ["Flashi Test::Many", ""],
    ["Flashi Test::Basics", "3141"],
    ["Flashi Test", "33213"],
  ] as const) {
    it(`${deck} after answers "${answers}"`, async () => {
      const expected = anki(deck, answers);
      const actual = await flashi(deck, answers);
      expect(actual.counts).toEqual(expected.counts);
      expect(actual.queueCounts).toEqual(expected.queueCounts);
      expect(actual.queue).toEqual(expected.queue);
    });
  }
});
