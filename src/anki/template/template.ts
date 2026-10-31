// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of Anki's card template engine: rslib/src/template.rs and
// rslib/src/template_filters.rs (Copyright: Ankitects Pty Ltd and contributors).

import { clozeFilter, clozeNumbersInString, clozeOnlyFilter } from "./cloze";
import { fieldIsEmpty, stripHtml } from "./text";

type ParsedNode =
  | { kind: "text"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "replacement"; key: string; filters: string[] }
  | { kind: "conditional"; key: string; negated: boolean; children: ParsedNode[] };

type Token =
  | { kind: "text"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "replacement"; text: string }
  | { kind: "open"; text: string }
  | { kind: "openNegated"; text: string }
  | { kind: "close"; text: string };

export class TemplateError extends Error {}

const ALT_DIRECTIVE = "{{=<% %>=}}";

function classify(s: string): Token {
  const start = s.replace(/^\{+/, "").trim();
  if (start.length < 2) return { kind: "replacement", text: start };
  if (start[0] === "#") return { kind: "open", text: start.slice(1).trimStart() };
  if (start[0] === "/") return { kind: "close", text: start.slice(1).trimStart() };
  if (start[0] === "^") return { kind: "openNegated", text: start.slice(1).trimStart() };
  return { kind: "replacement", text: start };
}

function tokenize(template: string): Token[] {
  let open = "{{";
  let close = "}}";
  if (template.trimStart().startsWith(ALT_DIRECTIVE)) {
    template = template.trimStart().slice(ALT_DIRECTIVE.length);
    open = "<%";
    close = "%>";
  }
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) tokens.push({ kind: "text", text: template.slice(textStart, end) });
  };
  while (i < template.length) {
    if (template.startsWith(open, i)) {
      const end = template.indexOf(close, i + open.length);
      if (end >= 0) {
        flushText(i);
        tokens.push(classify(template.slice(i + open.length, end)));
        i = end + close.length;
        textStart = i;
        continue;
      }
    }
    if (template.startsWith("<!--", i)) {
      const end = template.indexOf("-->", i + 4);
      if (end >= 0) {
        flushText(i);
        tokens.push({ kind: "comment", text: template.slice(i + 4, end) });
        i = end + 3;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(template.length);
  return tokens;
}

function parseInner(tokens: Token[], pos: { i: number }, openTag: string | null): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  while (pos.i < tokens.length) {
    const t = tokens[pos.i++]!;
    switch (t.kind) {
      case "text":
        nodes.push({ kind: "text", text: t.text });
        break;
      case "comment":
        nodes.push({ kind: "comment", text: t.text });
        break;
      case "replacement": {
        const parts = t.text.split(":");
        const key = parts.pop()!;
        nodes.push({ kind: "replacement", key, filters: parts.reverse() });
        break;
      }
      case "open":
      case "openNegated":
        nodes.push({
          kind: "conditional",
          key: t.text,
          negated: t.kind === "openNegated",
          children: parseInner(tokens, pos, t.text),
        });
        break;
      case "close":
        if (openTag === t.text) return nodes;
        throw new TemplateError(
          openTag
            ? `Found '{{/${t.text}}}', but expected '{{/${openTag}}}'.`
            : `Found '{{/${t.text}}}', but missing '{{#${t.text}}}' or '{{^${t.text}}}'.`,
        );
    }
  }
  if (openTag !== null) throw new TemplateError(`Missing '{{/${openTag}}}'.`);
  return nodes;
}

export function parseTemplate(template: string): ParsedNode[] {
  return parseInner(tokenize(template), { i: 0 }, null);
}

export interface RenderContext {
  fields: Map<string, string>;
  nonEmptyFields: Set<string>;
  cardOrd: number;
  /** Rendered question, available while rendering the answer side. */
  frontSide: string | null;
}

function isClozeConditional(key: string): boolean {
  return /^c\d+$/.test(key);
}

let hintCounter = 0;

function hintFilter(text: string, fieldName: string): string {
  if (!text.trim()) return text;
  const id = `${Date.now().toString(16)}${(hintCounter++).toString(16)}`;
  return `
<a class=hint href="#"
onclick="this.style.display='none';
document.getElementById('hint${id}').style.display='block';
return false;" draggable=false>
${fieldName}</a>
<div id="hint${id}" class=hint style="display: none">${text}</div>
`;
}

const FURIGANA = / ?([^ >]+?)\[(.+?)\]/g;

function furigana(text: string, mode: "furigana" | "kanji" | "kana"): string {
  return text.replace(/&nbsp;/g, " ").replace(FURIGANA, (whole, base: string, reading: string) => {
    if (reading.startsWith("sound:")) return whole;
    if (mode === "kanji") return base;
    if (mode === "kana") return reading;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

const TYPE_MODIFIERS = ["cloze", "nc", "ci"];

function typeFilter(fieldName: string, modifiers: string[]): string {
  const prefix = TYPE_MODIFIERS.filter((m) => modifiers.includes(m))
    .map((m) => `${m}:`)
    .join("");
  return `[[type:${prefix}${fieldName}]]`;
}

function applyFilters(text: string, filters: string[], fieldName: string, ctx: RenderContext): string {
  if (filters.length && filters[filters.length - 1] === "type") {
    return typeFilter(fieldName, filters.slice(0, -1));
  }
  for (const f of filters) {
    switch (f) {
      case "text":
        text = stripHtml(text);
        break;
      case "furigana":
      case "kanji":
      case "kana":
        text = furigana(text, f);
        break;
      case "type":
        text = typeFilter(fieldName, []);
        break;
      case "type-cloze":
        text = typeFilter(fieldName, ["cloze"]);
        break;
      case "type-nc":
        text = typeFilter(fieldName, ["nc"]);
        break;
      case "hint":
        text = hintFilter(text, fieldName);
        break;
      case "cloze":
        text = clozeFilter(text, ctx.cardOrd, ctx.frontSide === null);
        break;
      case "cloze-only":
        text = clozeOnlyFilter(text, ctx.cardOrd, ctx.frontSide === null);
        break;
      case "":
        break;
      default:
        if (f.startsWith("tts ")) text = `[anki:tts lang=${f.slice(4)}]${text}[/anki:tts]`;
      // Unknown filters (add-on filters) are ignored, as in Anki without the add-on.
    }
  }
  return text;
}

function renderInto(out: string[], nodes: ParsedNode[], ctx: RenderContext): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out.push(node.text);
        break;
      case "comment":
        out.push(`<!--${node.text}-->`);
        break;
      case "replacement": {
        if (node.key === "FrontSide") {
          out.push(ctx.frontSide ?? "");
          break;
        }
        if (node.key === "" && node.filters.length) break;
        const value = ctx.fields.get(node.key);
        if (value === undefined) {
          const filters = [...node.filters].reverse().concat("").join(":");
          throw new TemplateError(`Found '{{${filters}${node.key}}}', but there is no field called '${node.key}'.`);
        }
        out.push(applyFilters(value, node.filters, node.key, ctx));
        break;
      }
      case "conditional": {
        let truthy: boolean;
        if (ctx.nonEmptyFields.has(node.key)) truthy = true;
        else if (ctx.fields.has(node.key) || isClozeConditional(node.key)) truthy = false;
        else throw new TemplateError(`There is no field called '${node.key}'.`);
        if (truthy !== node.negated) renderInto(out, node.children, ctx);
        break;
      }
    }
  }
}

export function renderTemplate(template: string, ctx: RenderContext): string {
  const out: string[] = [];
  renderInto(out, parseTemplate(template), ctx);
  return out.join("");
}

/** True if the template references any non-empty field (otherwise the card would be blank). */
function rendersWithFields(nodes: ParsedNode[], nonEmpty: Set<string>): boolean {
  for (const node of nodes) {
    if (node.kind === "replacement" && nonEmpty.has(node.key)) return true;
    if (node.kind === "conditional") {
      if (node.negated) {
        if (rendersWithFields(node.children, nonEmpty)) return true;
      } else if (nonEmpty.has(node.key) && rendersWithFields(node.children, nonEmpty)) return true;
    }
  }
  return false;
}

export interface RenderedCard {
  question: string;
  answer: string;
  isEmpty: boolean;
}

export function renderCard(
  qfmt: string,
  afmt: string,
  fields: Map<string, string>,
  cardOrd: number,
  isCloze: boolean,
): RenderedCard {
  const nonEmptyFields = new Set<string>();
  for (const [name, value] of fields) if (!fieldIsEmpty(value)) nonEmptyFields.add(name);
  const ctx: RenderContext = { fields, nonEmptyFields, cardOrd, frontSide: null };
  const question = renderTemplate(qfmt, ctx);
  let emptyMessage: string | null = null;
  if (isCloze) {
    const ords = new Set<number>();
    for (const v of fields.values()) for (const o of clozeNumbersInString(v)) ords.add(o);
    if (!ords.has(cardOrd + 1)) {
      emptyMessage = `<div>No cloze ${cardOrd + 1} found on card. Please either add a cloze deletion, or use the Empty Cards tool.</div>`;
    }
  } else if (!rendersWithFields(parseTemplate(qfmt), nonEmptyFields)) {
    emptyMessage = "<div>The front of this card is blank.</div>";
  }
  if (emptyMessage) return { question: question + emptyMessage, answer: emptyMessage, isEmpty: true };
  ctx.frontSide = question;
  return { question, answer: renderTemplate(afmt, ctx), isEmpty: false };
}
