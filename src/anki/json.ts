// SPDX-License-Identifier: AGPL-3.0-or-later
// Anki's schema-11 JSON contains 64-bit ids (template/field ids) that do not
// fit in a JS number. These helpers round-trip them losslessly by turning
// unsafe integers into tagged strings on parse and back into bare numbers on
// stringify.

const TAG = "\u0000int:";

/** Parse JSON, keeping integers beyond ±2^53 as tagged strings. */
export function parseJson<T = unknown>(text: string): T {
  let out = "";
  let i = 0;
  let last = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 34 /* " */) {
      i++;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 92 /* \ */) i += 2;
        else if (c === 34) {
          i++;
          break;
        } else i++;
      }
    } else if (ch === 45 /* - */ || (ch >= 48 && ch <= 57)) {
      const start = i;
      i++;
      while (i < n && /[0-9.eE+-]/.test(text[i]!)) i++;
      const token = text.slice(start, i);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += text.slice(last, start) + JSON.stringify(TAG + token);
        last = i;
      }
    } else i++;
  }
  out += text.slice(last);
  return JSON.parse(out) as T;
}

/** Stringify JSON, restoring tagged big integers as bare numbers. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value).replace(/"\\u0000int:(-?\d+)"/g, "$1");
}

export function isTaggedInt(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(TAG);
}

/** A tagged or plain integer as a decimal string (for comparisons). */
export function intString(v: unknown): string {
  return isTaggedInt(v) ? v.slice(TAG.length) : String(v);
}

/** Wrap a bigint so stringifyJson writes it as a bare JSON number. */
export function taggedBigInt(v: bigint): string | number {
  const asNum = Number(v);
  return Number.isSafeInteger(asNum) ? asNum : TAG + v.toString();
}
