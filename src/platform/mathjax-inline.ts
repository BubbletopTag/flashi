// SPDX-License-Identifier: AGPL-3.0-or-later
// Artifact build: MathJax 3 (Apache-2.0) is inlined and injected only into
// cards that contain \( … \) or \[ … \].
import source from "mathjax/es5/tex-svg.js?raw";

export function mathjaxScript(): string {
  return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
}
