// SPDX-License-Identifier: AGPL-3.0-or-later
// Vitest: read the SQLite WASM binary from node_modules.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export async function sqliteWasmBytes(): Promise<BufferSource> {
  const require = createRequire(import.meta.url);
  const path = require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
  return new Uint8Array(await readFile(path));
}
