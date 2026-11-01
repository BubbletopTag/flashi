// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Collection } from "../src/anki/collection";
import { exportPackage } from "../src/anki/apkg/export";
import { importPackage } from "../src/anki/apkg/import";
import { bytesSource } from "../src/anki/apkg/zip";
import { num, str } from "../src/anki/sqlite";
import { MemoryMediaStore } from "../src/storage/media";
import { saveNote } from "../src/anki/management/notes";

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "decks", name)));

async function importFixture(name: string, col?: Collection, media = new MemoryMediaStore()) {
  const target = col ?? (await Collection.create());
  const result = await importPackage(target, media, bytesSource(fixture(name)));
  return { col: target, media, result };
}

/** Scheduling-relevant card fields, keyed by note GUID + template, due made relative to today. */
function cardSummary(col: Collection) {
  const today = col.timing().daysElapsed;
  return col.db
    .all(
      `select n.guid, c.ord, c.type, c.queue, case when c.queue in (2, 3) or c.type = 2 then c.due - ? else c.due end,
        c.ivl, c.factor, c.reps, c.lapses, c.left
       from cards c join notes n on n.id = c.nid order by n.guid, c.ord`,
      [today],
    )
    .map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));
}

function deckNames(col: Collection) {
  return col.decksSorted().map((d) => d.name);
}

describe("apkg import", () => {
  it("imports a legacy (schema 11) export with scheduling and media", async () => {
    const { col, media, result } = await importFixture("legacy-anki21.apkg");
    expect(result.notesAdded).toBe(37);
    expect(result.cardsAdded).toBe(40);
    expect(deckNames(col)).toEqual(
      expect.arrayContaining(["Flashi Test", "Flashi Test::Basics", "Flashi Test::Cloze", "Flashi Test::Japanese", "Flashi Test::Many"]),
    );
    expect((await media.list()).sort()).toEqual(["beep.wav", "green.png", "日本.png"]);
    expect(num(col.db.scalar("select count(*) from cards where type = 2"))).toBeGreaterThanOrEqual(5);
    expect(num(col.db.scalar("select count(*) from revlog"))).toBeGreaterThan(0);
    const png = await media.get("green.png");
    expect(new Uint8Array(await png!.arrayBuffer()).slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));
  });

  it("imports the current (schema 18, zstd) format identically", async () => {
    const legacy = await importFixture("legacy-anki21.apkg");
    const latest = await importFixture("latest-anki21b.apkg");
    expect(cardSummary(latest.col)).toEqual(cardSummary(legacy.col));
    expect(deckNames(latest.col)).toEqual(deckNames(legacy.col));
    expect((await latest.media.list()).sort()).toEqual((await legacy.media.list()).sort());
    const cloze = Object.values(latest.col.models).find((m) => m.name === "Cloze");
    expect(cloze.type).toBe(1);
    expect(cloze.tmpls[0].qfmt).toContain("{{cloze:Text}}");
    const jp = Object.values(latest.col.models).find((m) => m.name === "Japanese (Flashi test)");
    expect(jp.flds.map((f: { name: string }) => f.name)).toEqual(["Expression", "Reading", "Meaning"]);
    const legacyJp = Object.values(legacy.col.models).find((m) => m.name === "Japanese (Flashi test)");
    expect(jp.tmpls[0].afmt).toBe(legacyJp.tmpls[0].afmt);
    expect(jp.css).toBe(legacyJp.css);
  });

  it("imports a package exported without scheduling as new cards", async () => {
    const { col, result } = await importFixture("schema18-noscheduling.apkg");
    expect(result.cardsAdded).toBe(40);
    expect(num(col.db.scalar("select count(*) from cards where type != 0"))).toBe(0);
  });

  it("imports genanki's collection.anki2-only packages", async () => {
    const { col, media, result } = await importFixture("genanki-anki2.apkg");
    expect(result.notesAdded).toBe(5);
    expect(deckNames(col)).toContain("Genanki Legacy");
    expect(await media.list()).toEqual(["g.png"]);
  });

  it("does not duplicate notes when the same package is imported twice", async () => {
    const first = await importFixture("legacy-anki21.apkg");
    const again = await importPackage(first.col, first.media, bytesSource(fixture("legacy-anki21.apkg")));
    expect(again.notesAdded).toBe(0);
    expect(again.cardsAdded).toBe(0);
    expect(first.col.noteCount()).toBe(37);
  });

  it("rejects files that are not packages", async () => {
    const col = await Collection.create();
    await expect(
      importPackage(col, new MemoryMediaStore(), bytesSource(new TextEncoder().encode("not a zip"))),
    ).rejects.toThrow(/not an Anki package/);
  });
});

describe("apkg export", () => {
  it("round-trips through Flashi", async () => {
    const { col, media } = await importFixture("legacy-anki21.apkg");
    const blob = await exportPackage(col, media);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const again = await Collection.create();
    const media2 = new MemoryMediaStore();
    await importPackage(again, media2, bytesSource(bytes));
    expect(cardSummary(again)).toEqual(cardSummary(col));
    expect((await media2.list()).sort()).toEqual((await media.list()).sort());
    expect(str(again.db.scalar("select count(*) from revlog"))).toBe(str(col.db.scalar("select count(*) from revlog")));
  });

  const python = process.env.FLASHI_ANKI_PYTHON ?? "python3";
  let haveAnki = false;
  try {
    execFileSync(python, ["-c", "import anki"], { stdio: "ignore" });
    haveAnki = true;
  } catch {
    haveAnki = false;
  }

  it.skipIf(!haveAnki)("imports into official Anki with scheduling preserved", async () => {
    const { col, media } = await importFixture("latest-anki21b.apkg");
    // Study a few cards in Flashi first, so the export carries Flashi-made history.
    const deck = col.deckByName("Flashi Test::Many")!;
    for (let i = 0; i < 5; i++) {
      const next = col.nextCard(deck.id);
      if (!next) break;
      col.answerCard(next.card.id, 3, 4000);
    }
    const blob = await exportPackage(col, media);
    const dir = mkdtempSync(join(tmpdir(), "flashi-export-"));
    const path = join(dir, "export.apkg");
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    expect(existsSync(path)).toBe(true);
    const out = JSON.parse(
      execFileSync(python, [join(__dirname, "..", "scripts", "check-export.py"), path], { encoding: "utf8" }),
    );
    const ours = cardSummary(col).map((r) => [...r.slice(0, 10), 0]);
    const theirs = (out.cards as unknown[][]).map((r) => [...r.slice(0, 10), 0]);
    expect(theirs).toEqual(ours);
    expect(out.notes).toBe(col.noteCount());
    expect(out.revlog).toBe(num(col.db.scalar("select count(*) from revlog")));
    expect(out.media).toEqual(["beep.wav", "green.png", "日本.png"]);
    expect(out.decks).toEqual(expect.arrayContaining(deckNames(col).filter((n) => n !== "Default")));
  });
  it.skipIf(!haveAnki)("exports newly authored basic, reversed and cloze notes to official Anki", async () => {
    const col=await Collection.create();const deckId=col.addDeck('Authored locally');
    for(const [name,fields] of [['Basic',['<b>A &amp; B</b>','Answer']],['Basic (and reversed card)',['Forward','Reverse']],['Cloze',['{{c1::One}} and {{c3::three}}','Extra']]] as const){
      const model=Object.values(col.models).find(model=>model.name===name)!;
      await saveNote(col,{modelId:Number(model.id),deckId,fields:[...fields],tags:'local::authored'});
    }
    const next=col.nextCard(deckId)!;col.answerCard(next.card.id,4,3000);
    const blob=await exportPackage(col,new MemoryMediaStore());const path=join(mkdtempSync(join(tmpdir(),'flashi-authored-')),'authored.apkg');writeFileSync(path,new Uint8Array(await blob.arrayBuffer()));
    const out=JSON.parse(execFileSync(python,[join(__dirname,'..','scripts','check-export.py'),path],{encoding:'utf8'}));
    expect(out.notes).toBe(3);expect(out.cards).toHaveLength(5);expect(out.revlog).toBe(1);expect(out.decks).toContain('Authored locally');
    expect(out.cards.map((row:unknown[])=>row.slice(0,10))).toEqual(cardSummary(col));col.db.close();
  });
});
