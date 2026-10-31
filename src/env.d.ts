// SPDX-License-Identifier: AGPL-3.0-or-later
declare const __FLASHI_TARGET__: "artifact" | "pwa";
declare const __FLASHI_GOLDEN__: boolean;
declare const __FLASHI_VERSION__: string;

declare module "#wasm-source" {
  export function sqliteWasmBytes(): Promise<BufferSource>;
}

declare module "#mathjax-source" {
  export function mathjaxScript(): string;
}

declare module "virtual:sqlite-wasm-base64" {
  const base64: string;
  export default base64;
}

declare module "virtual:third-party-notices" {
  const notices: string;
  export default notices;
}
