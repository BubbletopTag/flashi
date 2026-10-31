// SPDX-License-Identifier: AGPL-3.0-or-later
// PWA / dev build: the SQLite WASM binary is a separate cached asset.
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";

export async function sqliteWasmBytes(): Promise<BufferSource> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not load the database engine (HTTP ${response.status})`);
  return response.arrayBuffer();
}
