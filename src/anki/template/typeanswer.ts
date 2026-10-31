// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/typeanswer.rs (Copyright: Ankitects Pty Ltd and contributors)
// with Python difflib's SequenceMatcher (PSF license; algorithm re-implemented).

import { escapeHtml, stripHtml } from "./text";

interface Opcode {
  tag: "equal" | "delete" | "insert" | "replace";
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

/** difflib.SequenceMatcher(None, a, b).get_opcodes(), with autojunk. */
export function getOpcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  const b2j = new Map<string, number[]>();
  b.forEach((ch, j) => {
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  });
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [ch, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(ch);
  }
  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // extend with popular (junk-free) elements
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1] && !b2j.has(b[bestj - 1]!)) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize] && !b2j.has(b[bestj + bestsize]!)) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const blocks: Array<[number, number, number]> = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number, number]> = [];
  for (const blk of blocks) {
    const last = merged[merged.length - 1];
    if (last && last[0] + last[2] === blk[0] && last[1] + last[2] === blk[1]) last[2] += blk[2];
    else merged.push([...blk]);
  }
  merged.push([a.length, b.length, 0]);
  const ops: Opcode[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of merged) {
    const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
    if (tag) ops.push({ tag, i1: i, i2: ai, j1: j, j2: bj });
    i = ai + size;
    j = bj + size;
    if (size) ops.push({ tag: "equal", i1: ai, i2: i, j1: bj, j2: j });
  }
  return ops;
}

const LINEBREAKS = /(\n|<br\s?\/?>|<\/?div>)+/gis;

function stripExpected(expected: string): string {
  const noAv = expected.replace(/\[sound:[^\]]+\]/g, "").replace(/\[anki:tts[^\]]*\].*?\[\/anki:tts\]/gs, "");
  return stripHtml(noAv.replace(LINEBREAKS, " ")).trim();
}

const chars = (s: string) => [...s.normalize("NFC")];

function fold(cs: string[]): string[] {
  return cs.map((c) => (c === "ς" ? "σ" : c === "ſ" ? "s" : (c.toLowerCase()[0] ?? c)));
}

function span(cls: string, text: string): string {
  const isolated = /^\p{M}/u.test(text) ? ` ${text}` : text;
  return `<span class=${cls}>${escapeHtml(isolated)}</span>`;
}

/** Compare a typed answer with the expected one (combining characters kept). */
export function compareAnswer(expected: string, typed: string, ignoreCase = false): string {
  const stripped = stripExpected(expected);
  if (!typed) return `<code id=typeans>${escapeHtml(stripped)}</code>`;
  const t = chars(typed);
  const e = chars(stripped);
  const tCmp = ignoreCase ? fold(t) : t;
  const eCmp = ignoreCase ? fold(e) : e;
  if (tCmp.join("") === eCmp.join("")) {
    return `<code id=typeans><span class=typeGood>${escapeHtml(e.join(""))}</span></code>`;
  }
  let typedHtml = "";
  let expectedHtml = "";
  for (const op of getOpcodes(tCmp, eCmp)) {
    const ts = t.slice(op.i1, op.i2).join("");
    const es = e.slice(op.j1, op.j2).join("");
    if (op.tag === "equal") {
      typedHtml += span("typeGood", ts);
      expectedHtml += span("typeGood", es);
    } else if (op.tag === "delete") typedHtml += span("typeBad", ts);
    else if (op.tag === "insert") {
      typedHtml += span("typeMissed", "-".repeat(op.j2 - op.j1));
      expectedHtml += span("typeMissed", es);
    } else {
      typedHtml += span("typeBad", ts);
      expectedHtml += span("typeMissed", es);
    }
  }
  return `<code id=typeans>${typedHtml}<br><span id=typearrow>&darr;</span><br>${expectedHtml}</code>`;
}
