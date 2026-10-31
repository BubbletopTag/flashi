// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal random-access ZIP reader (reads only the central directory up
// front, then single members on demand, so large .apkg files are never held
// in memory whole) and a streaming writer built on fflate (MIT).

import { inflateSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
  };
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {}

const utf8 = new TextDecoder();

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u64(b: Uint8Array, o: number): number {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>();

  private constructor(private readonly src: ByteSource) {}

  static async open(src: ByteSource): Promise<ZipReader> {
    const reader = new ZipReader(src);
    await reader.readDirectory();
    return reader;
  }

  private async readDirectory(): Promise<void> {
    const tailLen = Math.min(this.src.size, 65_557);
    const tail = await this.src.read(this.src.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipFormatError("This file is not an Anki package (no zip directory found).");
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOffset = u32(tail, eocd + 16);
    // ZIP64 end of central directory locator sits just before the EOCD.
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64Offset = u64(tail, loc + 8);
      const z64 = await this.src.read(z64Offset, 56);
      if (u32(z64, 0) === 0x06064b50) {
        count = u64(z64, 32);
        cdSize = u64(z64, 40);
        cdOffset = u64(z64, 48);
      }
    }
    const cd = await this.src.read(cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (u32(cd, p) !== 0x02014b50) throw new ZipFormatError("The package's zip directory is damaged.");
      const method = u16(cd, p + 10);
      let compressedSize = u32(cd, p + 20);
      let size = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      let localHeaderOffset = u32(cd, p + 42);
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extended information extra field
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = u16(cd, e);
        const len = u16(cd, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = u64(cd, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(cd, q);
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
        }
        e += 4 + len;
      }
      this.entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Raw (still compressed) bytes of a member. */
  async readRaw(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipFormatError(`The package is missing "${name}".`);
    const header = await this.src.read(entry.localHeaderOffset, 30);
    if (u32(header, 0) !== 0x04034b50) throw new ZipFormatError(`The package entry "${name}" is damaged.`);
    const dataStart = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
    return this.src.read(dataStart, entry.compressedSize);
  }

  /** Member bytes after zip-level decompression (stored or deflate). */
  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    const raw = await this.readRaw(name);
    if (!entry || entry.method === 0) return raw;
    if (entry.method === 8) return inflateSync(raw, { out: new Uint8Array(entry.size) });
    throw new ZipFormatError(`Unsupported compression method ${entry.method} in "${name}".`);
  }
}

/** Streaming ZIP writer producing a Blob. */
export class ZipWriter {
  private readonly chunks: Uint8Array[] = [];
  private readonly zip: Zip;
  private error: Error | null = null;
  private done: Promise<void>;

  constructor() {
    let resolve!: () => void;
    this.done = new Promise((r) => (resolve = r));
    this.zip = new Zip((err, chunk, final) => {
      if (err) this.error = err;
      else this.chunks.push(chunk);
      if (final || err) resolve();
    });
  }

  addStored(name: string, data: Uint8Array): void {
    const file = new ZipPassThrough(name);
    this.zip.add(file);
    file.push(data, true);
  }

  addDeflated(name: string, data: Uint8Array): void {
    const file = new ZipDeflate(name, { level: 6 });
    this.zip.add(file);
    file.push(data, true);
  }

  async finish(): Promise<Blob> {
    this.zip.end();
    await this.done;
    if (this.error) throw this.error;
    return new Blob(this.chunks as BlobPart[], { type: "application/zip" });
  }
}
