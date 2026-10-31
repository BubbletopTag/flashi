// SPDX-License-Identifier: AGPL-3.0-or-later
// Artifact build: the SQLite WASM binary is inlined into the single HTML file.
import wasmDataUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?inline";

export async function sqliteWasmBytes(): Promise<BufferSource> {
  const base64 = wasmDataUrl.slice(wasmDataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
