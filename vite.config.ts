// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Build targets (one source):
 *   --mode artifact  → dist/flashi.html, everything inlined (claude.ai artifact)
 *   --mode golden    → dist-golden/flashi.html, artifact build that also ships the
 *                      dev-only `golden` theme (?theme=golden) for screenshot diffs
 *   --mode pwa       → dist-pwa/ for GitHub Pages
 *   dev / test       → golden theme available, WASM loaded from node_modules
 */
export default defineConfig(({ mode }) => {
  const singleFile = mode === "artifact" || mode === "golden";
  const golden = mode !== "artifact" && mode !== "pwa";
  const wasmSource =
    mode === "test" ? "src/platform/wasm-node.ts" : singleFile ? "src/platform/wasm-inline.ts" : "src/platform/wasm-url.ts";

  const mathjaxSource =
    mode === "test" ? "src/platform/mathjax-none.ts" : singleFile ? "src/platform/mathjax-inline.ts" : "src/platform/mathjax-url.ts";

  return {
    base: "./",
    publicDir: mode === "pwa" ? "public" : false,
    define: {
      __FLASHI_TARGET__: JSON.stringify(singleFile ? "artifact" : "pwa"),
      __FLASHI_GOLDEN__: JSON.stringify(golden),
      __FLASHI_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
    },
    resolve: {
      alias: {
        "#wasm-source": fileURLToPath(new URL(wasmSource, import.meta.url)),
        "#mathjax-source": fileURLToPath(new URL(mathjaxSource, import.meta.url)),
      },
    },
    plugins: [inlineWasm(), ...(singleFile ? [viteSingleFile({ removeViteModuleLoader: true }), renameHtml("flashi.html")] : [])],
    build: {
      outDir: mode === "golden" ? "dist-golden" : singleFile ? "dist" : "dist-pwa",
      emptyOutDir: true,
      target: "es2022",
      assetsInlineLimit: singleFile ? Number.MAX_SAFE_INTEGER : 4096,
      chunkSizeWarningLimit: 4096,
    },
    test: {
      include: ["tests/**/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
    },
  };
});

/** `virtual:sqlite-wasm-base64`: the SQLite WASM binary as a base64 string (artifact build). */
function inlineWasm(): Plugin {
  const id = "virtual:sqlite-wasm-base64";
  return {
    name: "flashi-inline-wasm",
    resolveId(source) {
      return source === id ? "\0" + id : null;
    },
    load(resolved) {
      if (resolved !== "\0" + id) return null;
      const path = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
      return `export default ${JSON.stringify(readFileSync(path).toString("base64"))};`;
    },
  };
}

function renameHtml(name: string): Plugin {
  return {
    name: "flashi-rename-html",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (html) html.fileName = name;
    },
  };
}
