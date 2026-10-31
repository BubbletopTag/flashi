// SPDX-License-Identifier: AGPL-3.0-or-later
// Where note media (images, audio) lives. Backends: IndexedDB (artifact,
// Safari tab), OPFS (PWA, Phase 3), memory (tests).

export interface MediaStore {
  get(name: string): Promise<Blob | null>;
  put(name: string, data: Blob): Promise<void>;
  /** Byte size, or null when the file is missing. */
  size(name: string): Promise<number | null>;
  list(): Promise<string[]>;
  totalBytes(): Promise<number>;
}

export class MemoryMediaStore implements MediaStore {
  readonly files = new Map<string, Blob>();

  async get(name: string) {
    return this.files.get(name) ?? null;
  }
  async put(name: string, data: Blob) {
    this.files.set(name, data);
  }
  async size(name: string) {
    return this.files.get(name)?.size ?? null;
  }
  async list() {
    return [...this.files.keys()];
  }
  async totalBytes() {
    let total = 0;
    for (const b of this.files.values()) total += b.size;
    return total;
  }
}
