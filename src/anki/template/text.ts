// SPDX-License-Identifier: AGPL-3.0-or-later
// Text helpers ported from rslib/src/text.rs (Copyright: Ankitects Pty Ltd and contributors).

const HTML = /(<!--.*?-->)|(<style.*?>.*?<\/style>)|(<script.*?>.*?<\/script>)|(<.*?>)/gis;

export function stripHtmlPreservingEntities(html: string): string {
  return html.replace(HTML, "");
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", deg: "°", times: "×",
};

export function decodeEntities(html: string): string {
  if (!html.includes("&")) return html;
  return html
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return NAMED[e.toLowerCase()] ?? m;
    })
    .replace(/ /g, " ");
}

export function stripHtml(html: string): string {
  return decodeEntities(stripHtmlPreservingEntities(html));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** htmlescape::encode_attribute: escapes everything that isn't alphanumeric. */
export function escapeAttribute(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (/[a-zA-Z0-9]/.test(ch) || code > 0x7f) out += ch;
    else if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#x27;";
    else out += `&#x${code.toString(16).toUpperCase().padStart(2, "0")};`;
  }
  return out;
}

/** Field counts as empty if it's only whitespace, <br> and <div> tags. */
export function fieldIsEmpty(text: string): boolean {
  return /^(?:\s|<\/?(?:br|div) ?\/?>)*$/i.test(text);
}
