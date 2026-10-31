// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/cloze.rs (Copyright: Ankitects Pty Ltd and contributors):
// nested clozes, multi-ordinal clozes (c1,2::), hints, and MathJax-aware
// tokenizing. Image occlusion is not supported yet.

import { escapeAttribute, stripHtmlPreservingEntities } from "./text";

type Token = { kind: "open"; ordinals: number[] } | { kind: "text"; text: string } | { kind: "close" };

interface Cloze {
  ordinals: number[];
  nodes: Node[];
  hint: string | null;
}

type Node = { text: string } | { cloze: Cloze };

function openCloze(text: string, i: number): { end: number; ordinals: number[] } | null {
  if (!text.startsWith("{{c", i)) return null;
  let j = i + 3;
  while (j < text.length && /[0-9,]/.test(text[j]!)) j++;
  const ords = [
    ...new Set(
      text
        .slice(i + 3, j)
        .split(",")
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
        .filter((n) => n <= 65535),
    ),
  ].sort((a, b) => a - b);
  if (!ords.length) return null;
  if (!text.startsWith("::", j)) return null;
  return { end: j + 2, ordinals: ords };
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // MathJax state: currently inside \( … \) or \[ … \]?
  let current: { close: string; id: number } | null = null;
  let nextId = 0;
  const clozeRegions: Array<number | null> = [];
  const region = () => (current ? current.id : null);
  const canClose = () => {
    const r = region();
    return r === null || clozeRegions[clozeRegions.length - 1] === r;
  };
  const consumeDelimiter = (rest: string): number | null => {
    if (!current) {
      for (const [open, close] of [["\\(", "\\)"], ["\\[", "\\]"]] as const) {
        if (rest.startsWith(open) && rest.slice(open.length).includes(close)) {
          current = { close, id: nextId++ };
          return open.length;
        }
      }
      return null;
    }
    if (rest.startsWith(current.close)) {
      const len = current.close.length;
      current = null;
      return len;
    }
    return null;
  };
  let pos = 0;
  while (pos < text.length) {
    const open = openCloze(text, pos);
    if (open) {
      clozeRegions.push(region());
      tokens.push({ kind: "open", ordinals: open.ordinals });
      pos = open.end;
      continue;
    }
    if (canClose() && text.startsWith("}}", pos)) {
      clozeRegions.pop();
      tokens.push({ kind: "close" });
      pos += 2;
      continue;
    }
    let i = pos;
    while (i < text.length) {
      if (openCloze(text, i) || (canClose() && text.startsWith("}}", i))) break;
      const consumed = consumeDelimiter(text.slice(i));
      if (consumed !== null) i += consumed;
      else i += text.codePointAt(i)! > 0xffff ? 2 : 1;
    }
    tokens.push({ kind: "text", text: text.slice(pos, i) });
    pos = i;
  }
  return tokens;
}

function parse(text: string): Node[] {
  const open: Cloze[] = [];
  const output: Node[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === "open") {
      if (open.length < 10) open.push({ ordinals: token.ordinals, nodes: [], hint: null });
    } else if (token.kind === "text") {
      const top = open[open.length - 1];
      if (top) {
        let t = token.text;
        if (!t.startsWith("image-occlusion:")) {
          const idx = t.indexOf("::");
          if (idx >= 0) {
            top.hint = t.slice(idx + 2);
            t = t.slice(0, idx);
          }
        }
        top.nodes.push({ text: t });
      } else output.push({ text: token.text });
    } else {
      const cloze = open.pop();
      if (cloze) {
        const parent = open[open.length - 1];
        (parent ? parent.nodes : output).push({ cloze });
      } else output.push({ text: "}}" });
    }
  }
  return output;
}

function clozedText(c: Cloze): string {
  return c.nodes.map((n) => ("text" in n ? n.text : clozedText(n.cloze))).join("");
}

const hint = (c: Cloze) => c.hint ?? "...";

function reveal(c: Cloze, ord: number, question: boolean, found: { v: boolean }): string {
  const active = c.ordinals.includes(ord);
  found.v ||= active;
  const ords = c.ordinals.join(",");
  const inner = () => c.nodes.map((n) => ("text" in n ? n.text : reveal(n.cloze, ord, question, found))).join("");
  if (question && active) {
    return `<span class="cloze" data-cloze="${escapeAttribute(inner())}" data-ordinal="${ords}">[${hint(c)}]</span>`;
  }
  if (active) return `<span class="cloze" data-ordinal="${ords}">${inner()}</span>`;
  return `<span class="cloze-inactive" data-ordinal="${ords}">${inner()}</span>`;
}

export function revealClozeText(text: string, ord: number, question: boolean): string {
  const found = { v: false };
  const out = parse(text)
    .map((n) => ("text" in n ? n.text : reveal(n.cloze, ord, question, found)))
    .join("");
  return found.v ? out : "";
}

function revealOnly(node: Node, ord: number, question: boolean, out: string[]): void {
  if (!("cloze" in node)) return;
  const c = node.cloze;
  if (c.ordinals.includes(ord)) out.push(question ? hint(c) : clozedText(c));
  for (const n of c.nodes) revealOnly(n, ord, question, out);
}

export function revealClozeTextOnly(text: string, ord: number, question: boolean): string {
  const out: string[] = [];
  for (const n of parse(text)) revealOnly(n, ord, question, out);
  return out.join(", ");
}

/** The expected answer for {{type:cloze:Field}}. */
export function extractClozeForTyping(text: string, ord: number): string {
  const out: string[] = [];
  for (const n of parse(text)) revealOnly(n, ord, false, out);
  if (!out.length) return "";
  return out.every((s) => s === out[0]) ? out[0]! : out.join(", ");
}

export function clozeNumbersInString(text: string): Set<number> {
  const set = new Set<number>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if ("cloze" in n) {
        for (const o of n.cloze.ordinals) if (o !== 0) set.add(o);
        walk(n.cloze.nodes);
      }
    }
  };
  walk(parse(text));
  return set;
}

const MATHJAX = /(\\[([])(.*?)(\\[\])])/gis;

export function clozeFilter(text: string, cardOrd: number, question: boolean): string {
  return revealClozeText(text, cardOrd + 1, question).replace(
    MATHJAX,
    (_m, open: string, inner: string, close: string) => `${open}${stripHtmlPreservingEntities(inner)}${close}`,
  );
}

export function clozeOnlyFilter(text: string, cardOrd: number, question: boolean): string {
  return revealClozeTextOnly(text, cardOrd + 1, question);
}
