// SPDX-License-Identifier: AGPL-3.0-or-later
// PWA build: MathJax 3 (Apache-2.0) is a separate, cacheable file. Sandboxed
// card frames can load it by absolute URL.
import url from "mathjax/es5/tex-svg.js?url";

export function mathjaxScript(): string {
  return `<script src="${new URL(url, location.href).href}"></script>`;
}
