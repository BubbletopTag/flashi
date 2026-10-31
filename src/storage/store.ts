// SPDX-License-Identifier: AGPL-3.0-or-later
// CollectionStore: where the serialized collection, its media and the
// pending-answers journal live. Phase 1 backend is IndexedDB (artifact and
// Safari tab); Phase 3 adds an OPFS backend for the installed PWA. Every
// call is wrapped so a missing or broken storage never stops the app from
// rendering: it falls back to memory and reports `persistent: false`.

import { MemoryMediaStore, type MediaStore } from "./media";

export interface JournalEntry {
  /** Auto-assigned key. */
  key?: number;
  cardId: number;
  rating: number;
  millisecondsTaken: number;
  answeredAtMs: number;
  /** The revlog id the answer produced (to detect already-saved answers). */
  revlogId: number;
}

export interface StoreMeta {
  savedAt?: number;
  lastExportAt?: number;
  createdAt?: number;
  /** Per-device preferences (reviewer title, ETA, …). */
  prefs?: Record<string, unknown>;
}

export interface CollectionStore {
  /** False when data won't survive a reload (storage unavailable). */
  readonly persistent: boolean;
  readonly media: MediaStore;
  loadCollection(): Promise<Uint8Array | null>;
  saveCollection(bytes: Uint8Array): Promise<void>;
  appendJournal(entry: JournalEntry): Promise<void>;
  readJournal(): Promise<JournalEntry[]>;
  clearJournal(upToKey: number): Promise<void>;
  getMeta(): Promise<StoreMeta>;
  setMeta(patch: Partial<StoreMeta>): Promise<void>;
  /** Wipe everything (used by "Delete all data"). */
  clear(): Promise<void>;
}

const DB_NAME = "flashi";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
      if (!db.objectStoreNames.contains("journal")) db.createObjectStore("journal", { keyPath: "key", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("Could not open IndexedDB"));
    r.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

class IdbMediaStore implements MediaStore {
  constructor(private readonly db: IDBDatabase) {}

  async get(name: string) {
    const v = await req(this.db.transaction("media").objectStore("media").get(name));
    return v instanceof Blob ? v : null;
  }
  async put(name: string, data: Blob) {
    const tx = this.db.transaction("media", "readwrite");
    tx.objectStore("media").put(data, name);
    await done(tx);
  }
  async size(name: string) {
    return (await this.get(name))?.size ?? null;
  }
  async list() {
    return (await req(this.db.transaction("media").objectStore("media").getAllKeys())).map(String);
  }
  async totalBytes() {
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const cursor = this.db.transaction("media").objectStore("media").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        if (c.value instanceof Blob) total += c.value.size;
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    return total;
  }
}

class IdbStore implements CollectionStore {
  readonly persistent = true;
  readonly media: MediaStore;

  constructor(private readonly db: IDBDatabase) {
    this.media = new IdbMediaStore(db);
  }

  private async kvGet<T>(key: string): Promise<T | undefined> {
    return (await req(this.db.transaction("kv").objectStore("kv").get(key))) as T | undefined;
  }

  private async kvPut(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    await done(tx);
  }

  async loadCollection() {
    const v = await this.kvGet<Uint8Array | ArrayBuffer>("collection");
    if (!v) return null;
    return v instanceof Uint8Array ? v : new Uint8Array(v);
  }
  async saveCollection(bytes: Uint8Array) {
    await this.kvPut("collection", bytes);
    await this.setMeta({ savedAt: Date.now() });
  }
  async appendJournal(entry: JournalEntry) {
    const tx = this.db.transaction("journal", "readwrite");
    const { key: _ignored, ...rest } = entry;
    tx.objectStore("journal").add(rest);
    await done(tx);
  }
  async readJournal() {
    return (await req(this.db.transaction("journal").objectStore("journal").getAll())) as JournalEntry[];
  }
  async clearJournal(upToKey: number) {
    const tx = this.db.transaction("journal", "readwrite");
    tx.objectStore("journal").delete(IDBKeyRange.upperBound(upToKey));
    await done(tx);
  }
  async getMeta() {
    return (await this.kvGet<StoreMeta>("meta")) ?? {};
  }
  async setMeta(patch: Partial<StoreMeta>) {
    const current = await this.getMeta();
    await this.kvPut("meta", { ...current, ...patch });
  }
  async clear() {
    const tx = this.db.transaction(["kv", "media", "journal"], "readwrite");
    for (const s of ["kv", "media", "journal"]) tx.objectStore(s).clear();
    await done(tx);
  }
}

/** Keeps everything in memory; used when IndexedDB is unavailable, and in tests. */
export class MemoryStore implements CollectionStore {
  readonly persistent = false;
  readonly media = new MemoryMediaStore();
  private bytes: Uint8Array | null = null;
  private journal: JournalEntry[] = [];
  private nextKey = 1;
  private meta: StoreMeta = {};

  async loadCollection() {
    return this.bytes;
  }
  async saveCollection(bytes: Uint8Array) {
    this.bytes = bytes;
    this.meta.savedAt = Date.now();
  }
  async appendJournal(entry: JournalEntry) {
    this.journal.push({ ...entry, key: this.nextKey++ });
  }
  async readJournal() {
    return [...this.journal];
  }
  async clearJournal(upToKey: number) {
    this.journal = this.journal.filter((e) => (e.key ?? 0) > upToKey);
  }
  async getMeta() {
    return { ...this.meta };
  }
  async setMeta(patch: Partial<StoreMeta>) {
    this.meta = { ...this.meta, ...patch };
  }
  async clear() {
    this.bytes = null;
    this.journal = [];
    this.meta = {};
    this.media.files.clear();
  }
}

/** Open IndexedDB storage, falling back to memory if the browser refuses. */
export async function openStore(): Promise<{ store: CollectionStore; error: string | null }> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");
    const db = await openDb();
    const store = new IdbStore(db);
    // Probe a write: some private modes open fine but refuse writes.
    await store.setMeta({});
    return { store, error: null };
  } catch (e) {
    return { store: new MemoryStore(), error: e instanceof Error ? e.message : String(e) };
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
