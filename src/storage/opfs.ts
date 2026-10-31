// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CollectionStore } from './store';
import type { MediaStore } from './media';

class WorkerStorage {
  private worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = () => this.close();
  }
  call<T>(method: string, args: object = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, ...args });
    });
  }
  close() {
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Local database storage stopped responding. Reload to try again.'));
    }
    this.pending.clear();
  }
}

class OpfsMedia implements MediaStore {
  constructor(private directory: FileSystemDirectoryHandle) {}
  // Encoding prevents deck filenames from traversing OPFS directories.
  private filename(name: string) { return encodeURIComponent(name); }
  async get(name: string): Promise<Blob | null> {
    try { return await (await this.directory.getFileHandle(this.filename(name))).getFile(); }
    catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; }
  }
  async put(name: string, blob: Blob) {
    const file = await this.directory.getFileHandle(this.filename(name), { create: true });
    const stream = await file.createWritable();
    try { await stream.write(blob); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  }
  async size(name: string) { return (await this.get(name))?.size ?? null; }
  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of (this.directory as any).keys()) names.push(decodeURIComponent(name));
    return names;
  }
  async totalBytes() {
    let total = 0;
    for (const name of await this.list()) total += (await this.size(name)) ?? 0;
    return total;
  }
  async clear() { for await (const name of (this.directory as any).keys()) await this.directory.removeEntry(name); }
}

/** Migrate once, retaining IndexedDB as a rollback copy until OPFS commits. */
export async function openOpfsStore(fallback: CollectionStore): Promise<CollectionStore> {
  const worker = new WorkerStorage();
  try {
    const root = await navigator.storage.getDirectory();
    const media = new OpfsMedia(await root.getDirectoryHandle('flashi-media', { create: true }));
    const meta = await fallback.getMeta();
    if (!meta.opfsMigrated) {
      for (const name of await fallback.media.list()) {
        const blob = await fallback.media.get(name);
        if (blob) await media.put(name, blob);
      }
      const bytes = await fallback.loadCollection();
      if (bytes) await worker.call('save', { bytes });
      else await worker.call('load'); // Initialize and probe before committing migration.
      await fallback.setMeta({ opfsMigrated: true });
    } else await worker.call('load');
    return {
      persistent: true, media,
      loadCollection: () => worker.call<Uint8Array | null>('load'),
      saveCollection: async (bytes) => { await worker.call('save', { bytes }); await fallback.setMeta({ savedAt: Date.now() }); },
      appendJournal: (entry) => fallback.appendJournal(entry),
      readJournal: () => fallback.readJournal(),
      clearJournal: (key) => fallback.clearJournal(key),
      getMeta: () => fallback.getMeta(),
      setMeta: (patch) => fallback.setMeta(patch),
      listBackups: () => worker.call<number[]>('backups'),
      readBackup: (backupId) => worker.call<Uint8Array | null>('backup', { backupId }),
      clear: async () => { await worker.call('clear'); await media.clear(); await fallback.clear(); worker.close(); },
    };
  } catch (error) { worker.close(); throw error; }
}
