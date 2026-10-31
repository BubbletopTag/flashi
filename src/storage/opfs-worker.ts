// SPDX-License-Identifier: AGPL-3.0-or-later
// Atomic collection snapshots in SQLite's worker-only opfs-sahpool VFS.
// Scheduling stays synchronous in the UI; only persistence crosses the worker.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { sqliteWasmBytes } from '#wasm-source';

let ready: Promise<any> | undefined;
function database(): Promise<any> {
  return ready ??= (async () => {
    const sqlite = await (sqlite3InitModule as any)({ wasmBinary: await sqliteWasmBytes(), print: () => {}, printErr: () => {} });
    const pool = await sqlite.installOpfsSAHPoolVfs({ directory: '/flashi-sqlite', preserveOnInitFailure: true });
    const db = new pool.OpfsSAHPoolDb('/flashi.sqlite3');
    db.exec(`create table if not exists collection (id integer primary key, bytes blob not null);
      create table if not exists backups (id integer primary key, bytes blob not null);`);
    return db;
  })();
}

// A single promise chain also orders async initialization and all mutations.
let operations = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const { id, method, bytes, backupId } = event.data;
  operations = operations.then(async () => {
    try {
      const db = await database();
      let value: unknown = null;
      switch (method) {
        case 'load': value = db.selectValue('select bytes from collection where id=1') ?? null; break;
        case 'save': {
          db.transaction(() => {
            db.exec({ sql: 'insert or replace into collection values (1, ?)', bind: [bytes] });
            const last = Number(db.selectValue('select max(id) from backups') ?? 0);
            db.exec({ sql: 'insert into backups select ?, ? where not exists (select 1 from backups where id=? and bytes=?)', bind: [Math.max(Date.now(), last + 1), bytes, last, bytes] });
            db.exec('delete from backups where id not in (select id from backups order by id desc limit 5)');
          });
          break;
        }
        case 'backups': value = db.selectValues('select id from backups order by id desc'); break;
        case 'backup': value = db.selectValue('select bytes from backups where id=?', [backupId]) ?? null; break;
        case 'clear': db.exec('delete from collection; delete from backups; vacuum;'); break;
        default: throw new Error('Unknown storage request');
      }
      self.postMessage({ id, value });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
