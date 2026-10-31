// SPDX-License-Identifier: AGPL-3.0-or-later
// Owns the collection and its storage: boot, journal replay, debounced saves,
// import/export, and the small amount of per-device state the UI needs.

import { Collection, nowSecs } from "../anki/collection";
import { exportPackage } from "../anki/apkg/export";
import { importPackage, type ImportProgress, type ImportResult } from "../anki/apkg/import";
import { blobSource } from "../anki/apkg/zip";
import type { Counts } from "../anki/scheduler/queue";
import { num } from "../anki/sqlite";
import { backupFilename, saveFile, type SaveOutcome } from "../platform/files";
import { openStore, type CollectionStore, type StoreMeta } from "../storage/store";
import { clearMediaCache } from "./cardFrame";

export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
export const WARN_IMPORT_BYTES = 100 * 1024 * 1024;
const SAVE_DELAY_MS = 1500;

export interface Prefs {
  showDeckTitle: boolean;
  showEta: boolean;
  autoplay: boolean;
}

const DEFAULT_PREFS: Prefs = { showDeckTitle: true, showEta: true, autoplay: true };

export class AppController {
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private lastJournalKey = 0;
  version = 0;
  saveError: string | null = null;

  private constructor(
    readonly col: Collection,
    readonly store: CollectionStore,
    readonly storageError: string | null,
    public meta: StoreMeta,
  ) {}

  static async temporary(col: Collection, store: CollectionStore): Promise<AppController> {
    return new AppController(col, store, null, await store.getMeta());
  }

  static async boot(): Promise<AppController> {
    const { store, error } = await openStore();
    let col: Collection;
    let fresh = false;
    const bytes = await store.loadCollection().catch((e: unknown) => {
      throw new Error(`Your saved data couldn't be read (${e instanceof Error ? e.message : String(e)}). Reload to try again.`);
    });
    if (!bytes) {
      col = await Collection.create();
      fresh = true;
    } else {
      try {
        col = await Collection.open(bytes);
      } catch (e) {
        throw new Error(`Your saved collection couldn't be opened (${e instanceof Error ? e.message : String(e)}). Your saved data has been kept. Try reloading or restoring a backup.`);
      }
    }
    let meta: StoreMeta = {};
    try {
      meta = await store.getMeta();
    } catch {
      meta = {};
    }
    const app = new AppController(col, store, error, meta);
    await app.replayJournal();
    if (fresh) {
      app.meta.createdAt ??= Date.now();
      await app.safeSetMeta({ createdAt: app.meta.createdAt });
      await app.saveNow();
    }
    app.installLifecycleHooks();
    return app;
  }

  // ------------------------------------------------------------ subscriptions

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ saving

  private async replayJournal(): Promise<void> {
    let entries;
    try {
      entries = await this.store.readJournal();
    } catch {
      return;
    }
    if (!entries.length) return;
    let replayed = 0;
    for (const e of entries.sort((a, b) => (a.key ?? 0) - (b.key ?? 0))) {
      this.lastJournalKey = Math.max(this.lastJournalKey, e.key ?? 0);
      if (this.col.db.scalar("select 1 from revlog where id = ?", [e.revlogId])) continue;
      try {
        const card = this.col.getCard(e.cardId);
        if (card) this.col.studyQueue(card.did, Math.floor(e.answeredAtMs / 1000));
        this.col.answerCard(e.cardId, e.rating, e.millisecondsTaken, e.answeredAtMs);
        replayed++;
      } catch {
        // The card was deleted or changed; nothing to replay.
      }
    }
    if (replayed) await this.saveNow();
    else await this.store.clearJournal(this.lastJournalKey).catch(() => {});
  }

  scheduleSave(delay = SAVE_DELAY_MS): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, delay);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const save = (this.saving ?? Promise.resolve()).then(async () => {
      const journalKey = this.lastJournalKey;
      try {
        await this.store.saveCollection(this.col.serialize());
        if (journalKey) await this.store.clearJournal(journalKey);
        this.meta.savedAt = Date.now();
        this.saveError = null;
      } catch (e) {
        this.saveError = e instanceof Error ? e.message : String(e);
      }
    });
    this.saving = save;
    await save;
    if (this.saving === save) this.saving = null;
    this.notify();
  }

  private installLifecycleHooks(): void {
    const flush = () => {
      if (this.saveTimer) void this.saveNow();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }

  private async safeSetMeta(patch: Partial<StoreMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    try {
      await this.store.setMeta(patch);
    } catch {
      // Not fatal: meta is advisory.
    }
  }

  // ------------------------------------------------------------ studying

  async answer(cardId: number, rating: number, millisecondsTaken: number): Promise<void> {
    const answeredAtMs = Date.now();
    this.col.answerCard(cardId, rating, millisecondsTaken, answeredAtMs);
    const revlogId = num(this.col.db.scalar("select max(id) from revlog where cid = ?", [cardId]));
    this.notify();
    try {
      await this.store.appendJournal({ cardId, rating, millisecondsTaken, answeredAtMs, revlogId });
      const entries = await this.store.readJournal();
      this.lastJournalKey = Math.max(this.lastJournalKey, ...entries.map((e) => e.key ?? 0));
    } catch {
      // Journal unavailable; the debounced save still runs.
    }
    this.scheduleSave();
  }

  changed(): void {
    this.notify();
    this.scheduleSave(500);
  }

  async undo(): Promise<string | null> {
    const label = this.col.undo();
    if (label) await this.saveNow();
    return label;
  }

  /** AnkiDroid's estimate of minutes left (libanki Scheduler.eta). */
  etaMinutes(counts: Counts): number {
    const timing = this.col.timing();
    const r = this.col.db.first(
      `select
        avg(case when type = 0 then case when ease > 1 then 1.0 else 0.0 end else null end),
        avg(case when type = 0 then time else null end),
        avg(case when type in (1, 3) then case when ease > 1 then 1.0 else 0.0 end else null end),
        avg(case when type in (1, 3) then time else null end),
        avg(case when type = 2 then case when ease > 1 then 1.0 else 0.0 end else null end),
        avg(case when type = 2 then time else null end)
      from revlog where id > ?`,
      [(timing.nextDayAt - 10 * 86_400) * 1000],
    );
    const v = (i: number) => num(r?.[i] ?? 0);
    const newTime = v(1) || 20000;
    const revRate = v(2) || 1;
    const revTime = v(3) || 20000;
    let relrnRate = v(4) || 1;
    const relrnTime = v(5) || 20000;
    const total = newTime * counts.new + relrnTime * counts.learning + revTime * counts.review;
    let toRelrn = counts.new;
    toRelrn += Math.ceil((1 - relrnRate) * counts.learning);
    toRelrn += Math.ceil((1 - revRate) * counts.review);
    relrnRate = Math.max(relrnRate, 0.05);
    let futureReps = 0;
    do {
      const failures = Math.trunc((1 - relrnRate) * toRelrn);
      futureReps += failures;
      toRelrn = failures;
    } while (toRelrn > 1);
    return Math.round((total + relrnTime * futureReps) / 60000);
  }

  // ------------------------------------------------------------ prefs

  prefs(): Prefs {
    return { ...DEFAULT_PREFS, ...(this.meta.prefs as Partial<Prefs> | undefined) };
  }

  async setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
    await this.safeSetMeta({ prefs: { ...this.prefs(), [key]: value } });
    this.notify();
  }

  // ------------------------------------------------------------ decks

  createDeck(name: string): number {
    const id = this.col.addDeck(name);
    this.changed();
    return id;
  }

  // ------------------------------------------------------------ import / export

  async importFile(file: Blob, onProgress: (p: ImportProgress) => void): Promise<ImportResult> {
    if (file.size > MAX_IMPORT_BYTES) {
      throw new Error("This file is larger than 500 MB, which is more than Flashi can import.");
    }
    const result = await importPackage(this.col, this.store.media, blobSource(file), onProgress, nowSecs());
    clearMediaCache();
    await this.saveNow();
    return result;
  }

  async exportBackup(onProgress?: (label: string) => void): Promise<{ outcome: SaveOutcome; filename: string }> {
    onProgress?.("Preparing backup…");
    await this.saveNow();
    const blob = await exportPackage(this.col, this.store.media, (p) => {
      if (p.phase === "media") onProgress?.(`Adding media ${p.done + 1} of ${p.total}…`);
    });
    const result = await saveFile(blob, backupFilename());
    if (result.outcome === "saved") {
      await this.safeSetMeta({ lastExportAt: Date.now() });
      this.notify();
    }
    return result;
  }

  async exportAutomaticBackup(id: number): Promise<void> {
    const bytes = await this.store.readBackup?.(id);
    if (!bytes) throw new Error("This automatic backup is no longer available.");
    const collection = await Collection.open(bytes);
    try {
      const blob = await exportPackage(collection, this.store.media);
      const result = await saveFile(blob, backupFilename(new Date(id)) + " automatic");
      if (result.outcome !== "saved") throw new Error("The backup couldn't be downloaded.");
    } finally { collection.db.close(); }
  }

  /** Days since the last export, or null if never exported. */
  daysSinceBackup(): number | null {
    if (!this.meta.lastExportAt) return null;
    return Math.floor((Date.now() - this.meta.lastExportAt) / 86_400_000);
  }

  async deleteAllData(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.saving) await this.saving;
    await this.store.clear();
    location.reload();
  }
}
