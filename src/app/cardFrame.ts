// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the document shown in the card's sandboxed iframe. Structure and
// base CSS follow AnkiDroid's assets/card_template.html and flashcard.css
// (GPL-3.0-or-later, Copyright AnkiDroid contributors). The frame runs with
// sandbox="allow-scripts" and no allow-same-origin, so deck HTML/JS can't
// read Flashi's storage; media is inlined as data: URLs and the frame talks
// to the app only through postMessage.

import { mathjaxScript } from "#mathjax-source";
import { containsMath, mediaReferences, rewriteMedia } from "../anki/template/render";
import type { MediaStore } from "../storage/media";

const FLASHCARD_CSS = `
body { margin: 0; padding: 0; overflow-wrap: break-word; }
li { text-align: start; }
pre { text-align: left; }
video { max-width: 100%; }
#content { margin: 0.5em; }
.typeGood { background-color: #0f0; }
.typeBad { background-color: #f00; }
.typeMissed { background-color: #ccc; }
#typeans { width: 100%; box-sizing: border-box; font-family: "Noto Sans Mono", ui-monospace, monospace; }
code#typeans { white-space: pre-wrap; font-variant-ligatures: none; }
.typePrompt { color: magenta; }
.replay-button { text-decoration: none; }
img { max-width: 100%; max-height: 90%; }
.replay-button span { display: inline-block; vertical-align: middle; padding: 5px; }
.replay-button span svg { stroke: none; fill: black; display: inline; height: 1em; width: 1em; min-width: 32px; min-height: 32px; }
.mathjax-needs-to-render { visibility: hidden; }
.flashi-template-error { color: #b00020; font-family: sans-serif; font-size: 16px; }
`;

/* Runs inside the sandboxed frame. Keep it dependency-free. */
const BRIDGE = `
(function () {
  function post(msg) { msg.flashi = 1; parent.postMessage(msg, "*"); }
  document.addEventListener("click", function (e) {
    var t = e.target;
    var replay = t && t.closest ? t.closest("a.replay-button") : null;
    if (replay) {
      e.preventDefault();
      post({ type: "play", side: replay.getAttribute("data-side"), index: Number(replay.getAttribute("data-index")) });
      return;
    }
    var link = t && t.closest ? t.closest("a[href]") : null;
    if (link) {
      var href = link.getAttribute("href") || "";
      if (/^https?:/i.test(href)) { e.preventDefault(); post({ type: "open", href: link.href }); return; }
      if (/^playsound:/i.test(href)) { e.preventDefault(); return; }
    }
    post({ type: "tap" });
  }, true);
  window.addEventListener("load", function () {
    if (document.body.getAttribute("data-side") === "a") {
      var ans = document.getElementById("answer");
      if (ans && ans.getBoundingClientRect().top > window.innerHeight * 0.5) ans.scrollIntoView();
    }
  });
})();
`;

const MATHJAX_CONFIG = `<script>
window.MathJax = {
  tex: { displayMath: [["\\\\[", "\\\\]"]], inlineMath: [["\\\\(", "\\\\)"]], processEscapes: false, processEnvironments: false, processRefs: false },
  svg: { fontCache: "global" },
  startup: { typeset: true }
};
</script>`;

const dataUrlCache = new Map<string, string>();
const MAX_CACHE = 60;

function blobToDataUrl(blob: Blob, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let url = String(reader.result);
      // Blob types are often empty for imported media; give SVG a proper type.
      if (url.startsWith("data:application/octet-stream") && /\.svg$/i.test(name)) {
        url = url.replace("data:application/octet-stream", "data:image/svg+xml");
      }
      resolve(url);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function resolveMedia(media: MediaStore, names: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const name of names) {
    let url = dataUrlCache.get(name);
    if (!url) {
      const blob = await media.get(name);
      if (!blob) continue;
      url = await blobToDataUrl(blob, name);
      dataUrlCache.set(name, url);
      if (dataUrlCache.size > MAX_CACHE) dataUrlCache.delete(dataUrlCache.keys().next().value!);
    }
    urls.set(name, url);
  }
  return urls;
}

export function clearMediaCache(): void {
  dataUrlCache.clear();
}

export async function buildCardDocument(opts: {
  body: string;
  css: string;
  ord: number;
  side: "q" | "a";
  media: MediaStore;
  bodyClass?: string;
}): Promise<string> {
  const urls = await resolveMedia(opts.media, mediaReferences(opts.body, opts.css));
  const body = rewriteMedia(opts.body, urls);
  const css = rewriteMedia(opts.css, urls);
  const math = containsMath(body) ? MATHJAX_CONFIG + mathjaxScript() : "";
  const cls = `card card${opts.ord + 1}${opts.bodyClass ? " " + opts.bodyClass : ""}`;
  return `<!doctype html>
<html class="mobile android linux js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${FLASHCARD_CSS}</style>
<style>${css.replace(/<\/style/gi, "<\\/style")}</style>
<script>${BRIDGE}</script>
${math}
</head>
<body class="${cls}" data-side="${opts.side}">
<div id="content" dir="auto">
${body}
</div>
</body>
</html>`;
}
