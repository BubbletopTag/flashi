// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin wrapper over the official SQLite WASM build (@sqlite.org/sqlite-wasm,
// Apache-2.0 + public domain), with the extra SQL functions and collation
// Anki's schema needs.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sqliteWasmBytes } from "#wasm-source";
import { fnvHashI64 } from "./rng";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sqlite3 = any;

let sqlitePromise: Promise<Sqlite3> | null = null;

export function loadSqlite(): Promise<Sqlite3> {
  // The published typings omit the Emscripten module options it accepts.
  const init = sqlite3InitModule as unknown as (options: object) => Promise<Sqlite3>;
  sqlitePromise ??= new Promise<Sqlite3>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The database engine took too long to start. Reload to try again.")), 30_000);
    init({
    print: () => {},
    printErr: (...args: unknown[]) => console.warn("sqlite:", ...args),
    instantiateWasm(imports: WebAssembly.Imports, onSuccess: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
      sqliteWasmBytes()
        .then((bytes) => WebAssembly.instantiate(bytes, imports))
        .then((r) => onSuccess(r.instance, r.module))
        .catch(reject);
      return {};
    },
    }).then(resolve, reject).finally(() => clearTimeout(timer));
  }).catch((error) => {
    sqlitePromise = null;
    throw error;
  });
  return sqlitePromise;
}

export type SqlValue = number | string | bigint | Uint8Array | null;
export type Row = SqlValue[];

const textDecoder = new TextDecoder();

/** Case-insensitive comparison like Anki's `unicase` collation. */
export function unicaseCompare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export class Db {
  private constructor(
    private readonly sqlite3: Sqlite3,
    private readonly db: any,
  ) {
    this.registerExtensions();
  }

  static async open(bytes?: Uint8Array): Promise<Db> {
    const sqlite3 = await loadSqlite();
    const raw = new sqlite3.oo1.DB(":memory:", "c");
    if (bytes && bytes.length) {
      // Anki writes WAL-mode files (header bytes 18/19 = 2). An in-memory
      // deserialized database can't use WAL, so mark it as rollback-journal.
      if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) {
        bytes = bytes.slice();
        bytes[18] = 1;
        bytes[19] = 1;
      }
      const capi = sqlite3.capi;
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = capi.sqlite3_deserialize(
        raw.pointer,
        "main",
        p,
        bytes.length,
        bytes.length,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc !== 0) {
        raw.close();
        throw new Error(`That file is not a readable SQLite database (code ${rc}).`);
      }
    }
    const db = new Db(sqlite3, raw);
    // Fail early (and readably) on garbage input.
    db.scalar("select count(*) from sqlite_master");
    return db;
  }

  private registerExtensions(): void {
    const { capi, wasm } = this.sqlite3;
    capi.sqlite3_create_collation_v2(
      this.db.pointer,
      "unicase",
      capi.SQLITE_UTF8,
      0,
      (_p: number, n1: number, s1: number, n2: number, s2: number) => {
        const heap: Uint8Array = wasm.heap8u();
        return unicaseCompare(textDecoder.decode(heap.slice(s1, s1 + n1)), textDecoder.decode(heap.slice(s2, s2 + n2)));
      },
      0,
    );
    this.db.createFunction({
      name: "fnvhash",
      arity: -1,
      deterministic: true,
      xFunc: (_ctx: number, ...args: Array<number | bigint>) => fnvHashI64(...args),
    });
  }

  exec(sql: string, bind?: SqlValue[] | Record<string, SqlValue>): void {
    this.db.exec({ sql, bind });
  }

  all(sql: string, bind?: SqlValue[]): Row[] {
    return this.db.exec({ sql, bind, rowMode: "array", returnValue: "resultRows" }) as Row[];
  }

  objects<T = Record<string, SqlValue>>(sql: string, bind?: SqlValue[]): T[] {
    return this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as T[];
  }

  first(sql: string, bind?: SqlValue[]): Row | undefined {
    return this.all(sql, bind)[0];
  }

  scalar(sql: string, bind?: SqlValue[]): SqlValue | undefined {
    return this.first(sql, bind)?.[0];
  }

  /** Iterate rows without materializing them all. */
  each(sql: string, bind: SqlValue[] | undefined, fn: (row: Row) => boolean | void): void {
    const stmt = this.db.prepare(sql);
    try {
      if (bind && bind.length) stmt.bind(bind);
      while (stmt.step()) {
        if (fn(stmt.get([])) === false) break;
      }
    } finally {
      stmt.finalize();
    }
  }

  transaction<T>(fn: () => T): T {
    this.exec("begin");
    try {
      const out = fn();
      this.exec("commit");
      return out;
    } catch (e) {
      this.exec("rollback");
      throw e;
    }
  }

  changes(): number {
    return this.db.changes();
  }

  /** Serialize the whole database to bytes. */
  export(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
  }

  close(): void {
    this.db.close();
  }
}

export function num(v: SqlValue | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

export function str(v: SqlValue | undefined): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return textDecoder.decode(v);
  return String(v);
}
