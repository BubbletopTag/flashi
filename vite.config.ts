// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
    server: { watch: { ignored: ["**/dist/**", "**/dist-pwa/**", "**/dist-golden/**", "**/golden/report/**", "**/test-results/**", "**/playwright-report/**"] } },
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
    plugins: [inlineWasm(), bundledNotices(), ...(mode === "pwa" ? [pwa()] : []), ...(singleFile ? [viteSingleFile({ removeViteModuleLoader: true }), renameHtml("flashi.html")] : [])],
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

function bundledNotices(): Plugin {
  return {
    name: "flashi-notices",
    resolveId: (id) => id === "virtual:third-party-notices" ? "\0" + id : null,
    load(id) {
      if (id !== "\0virtual:third-party-notices") return null;
      const files = ["NOTICE.md", "LICENSE", ...["preact", "ts-fsrs", "fflate", "fzstd", "mathjax", "@fontsource/roboto"].map((name) => `node_modules/${name}/LICENSE`)];
      const contents = files.map((file) => `${file}\n\n${readFileSync(file, "utf8")}`).join("\n\n────────────────────────────────\n\n");
      return `export default ${JSON.stringify(contents)}`;
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
      for (const key of Object.keys(bundle)) if (/sqlite3-worker1-.*\.js$/.test(key)) delete bundle[key];
    },
  };
}

/** Build a versioned, scope-relative precache, including WASM, workers and fonts. */
function pwa(): Plugin {
  return {
    name: "flashi-pwa",
    transformIndexHtml() {
      return [
        { tag: "link", attrs: { rel: "manifest", href: "./manifest.webmanifest" }, injectTo: "head" },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "./icons/flashi-180.png" }, injectTo: "head" },
      ];
    },
    generateBundle(_options, bundle) {
      const publicFiles = readdirSync("public", { recursive: true }).map(String).filter((name) => /\.(png|webmanifest)$/.test(name));
      const files = ["./", ...Object.keys(bundle), ...publicFiles];
      const hash = createHash("sha256");
      for (const [name, item] of Object.entries(bundle)) hash.update(name).update(item.type === "chunk" ? item.code : item.source);
      for (const name of publicFiles) hash.update(readFileSync(`public/${name}`));
      const version = hash.digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `
const CACHE = 'flashi-${version}';
const ROOT = new URL('./', self.location.href);
const FILES = ${JSON.stringify(files)}.map(file => new URL(file, ROOT).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('flashi-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (event.request.mode === 'navigate') return (await cache.match(ROOT.href)) || fetch(event.request);
    return (await cache.match(event.request, { ignoreSearch: true })) || fetch(event.request);
  })());
});
` });
    },
  };
}
