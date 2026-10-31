// SPDX-License-Identifier: AGPL-3.0-or-later
// Card rendering: Anki's field map and template rendering (rslib/src/notetype/render.rs,
// Copyright: Ankitects Pty Ltd and contributors), with the HTML wrapper,
// replay buttons and type-answer box AnkiDroid uses (card_template.html,
// SoundUtils.kt, TypeAnswer.kt; GPL-3.0-or-later, Copyright AnkiDroid contributors).

import type { Collection } from "../collection";
import type { Json } from "../config";
import { splitFields, splitTags, type Card } from "../model";
import { extractClozeForTyping } from "./cloze";
import { renderCard, TemplateError } from "./template";
import { compareAnswer } from "./typeanswer";
import { escapeHtml } from "./text";

export type AvTag = { kind: "sound"; filename: string } | { kind: "tts"; lang: string; text: string };

export interface CardContent {
  question: string;
  answer: string;
  css: string;
  ord: number;
  questionAv: AvTag[];
  answerAv: AvTag[];
  /** Set when the template has a {{type:…}} field. */
  typeAnswer: { expected: string; ignoreCase: boolean } | null;
}

const TYPE_TAG = /\[\[type:(.+?)\]\]/;

function fieldMap(col: Collection, card: Card, model: Json, fields: string[], template: Json, tags: string): Map<string, string> {
  const map = new Map<string, string>();
  (model.flds as Json[]).forEach((f, i) => map.set(String(f.name), fields[i] ?? ""));
  const deck = col.deck(card.odid || card.did);
  const deckName = deck?.name ?? "(Deck)";
  const specials: Array<[string, string]> = [
    ["Tags", splitTags(tags).join(" ")],
    ["Type", String(model.name)],
    ["Subdeck", deckName.split("::").pop() ?? deckName],
    ["Deck", deckName],
    ["CardFlag", `flag${card.flags & 0b111}`],
    ["Card", String(template.name)],
    ["CardID", String(card.id)],
  ];
  for (const [k, v] of specials) if (!map.has(k)) map.set(k, v);
  return map;
}

/** Replace [sound:…] and [anki:tts …]…[/anki:tts] with play buttons, collecting the tags. */
function extractAv(html: string, side: "q" | "a", tags: AvTag[]): string {
  return html.replace(/\[sound:(.+?)\]|\[anki:tts lang=([^\]]*)\](.*?)\[\/anki:tts\]/gs, (_m, file?: string, lang?: string, text?: string) => {
    const index = tags.length;
    tags.push(file !== undefined ? { kind: "sound", filename: file } : { kind: "tts", lang: lang ?? "", text: text ?? "" });
    return `<a class="replay-button soundLink" href="playsound:${side}:${index}" data-side="${side}" data-index="${index}"><span>
                        <svg class="playImage" viewBox="0 0 64 64" version="1.1">
                            <circle cx="32" cy="32" r="29" fill="lightgrey"/>
                            <path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z" fill="black"/>Replay
                        </svg>
                    </span></a>`;
  });
}

export function renderCardContent(col: Collection, card: Card): CardContent {
  const note = col.getNote(card.nid);
  const model = note ? col.model(note.mid) : null;
  if (!note || !model) {
    const msg = "<div>This card's note or note type is missing.</div>";
    return { question: msg, answer: msg, css: "", ord: card.ord, questionAv: [], answerAv: [], typeAnswer: null };
  }
  const isCloze = model.type === 1;
  const templates = model.tmpls as Json[];
  const template = (isCloze ? templates[0] : templates.find((t) => t.ord === card.ord) ?? templates[card.ord]) ?? templates[0];
  const fields = splitFields(note.flds);
  const map = fieldMap(col, card, model, fields, template, note.tags);
  const questionAv: AvTag[] = [];
  const answerAv: AvTag[] = [];
  let question: string;
  let answer: string;
  try {
    const r = renderCard(String(template.qfmt ?? ""), String(template.afmt ?? ""), map, card.ord, isCloze, (q) =>
      extractAv(q, "q", questionAv),
    );
    question = r.question;
    answer = extractAv(r.answer, "a", answerAv);
  } catch (e) {
    const msg = `<div class="flashi-template-error">${escapeHtml(e instanceof TemplateError ? e.message : String(e))}</div>`;
    question = msg;
    answer = msg;
  }

  let typeAnswer: CardContent["typeAnswer"] = null;
  const typeMatch = TYPE_TAG.exec(question);
  if (typeMatch) {
    const parts = typeMatch[1]!.split(":");
    const fieldName = parts.pop()!;
    const value = map.get(fieldName);
    if (value === undefined) {
      question = question.replace(TYPE_TAG, `(Error: field “${escapeHtml(fieldName)}” not found)`);
    } else {
      const expected = parts.includes("cloze") ? extractClozeForTyping(value, card.ord + 1) : value;
      typeAnswer = { expected, ignoreCase: parts.includes("ci") };
      // AnkiDroid's default (useInputTag off): a placeholder in the card, and a
      // native input bar below it (see the reviewer).
      question = question.replace(TYPE_TAG, `<span id="typeans" class="typePrompt">........</span>`);
    }
  }
  // Remaining type tags (e.g. in {{FrontSide}}) are stripped; the answer gets the comparison.
  question = question.replace(new RegExp(TYPE_TAG.source, "g"), "");

  return { question, answer, css: String(model.css ?? ""), ord: card.ord, questionAv, answerAv, typeAnswer };
}

/** Answer HTML with the typed answer compared against the expected one. */
export function answerWithTyped(content: CardContent, typed: string): string {
  if (!content.typeAnswer) return content.answer.replace(new RegExp(TYPE_TAG.source, "g"), "");
  const comparison = compareAnswer(content.typeAnswer.expected, typed, content.typeAnswer.ignoreCase);
  let done = false;
  return content.answer.replace(new RegExp(TYPE_TAG.source, "g"), () => {
    if (done) return "";
    done = true;
    return comparison;
  });
}

/** Media filenames referenced from HTML or CSS (img/audio/video src, CSS url()). */
export function mediaReferences(...texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\s(?:src|data|poster)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
      const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (v && !/^(?:[a-z]+:|\/\/|#)/i.test(v)) names.add(safeDecode(v));
    }
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const v = m[1]!.trim();
      if (v && !/^(?:[a-z]+:|\/\/|#)/i.test(v)) names.add(safeDecode(v));
    }
  }
  return [...names];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Rewrite media references to the given URLs (data: URLs work in sandboxed frames). */
export function rewriteMedia(text: string, urls: ReadonlyMap<string, string>): string {
  const swap = (raw: string): string | null => {
    const v = raw.trim();
    return urls.get(safeDecode(v)) ?? urls.get(v) ?? null;
  };
  return text
    .replace(/(\s(?:src|data|poster)\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi, (whole, pre: string, a?: string, b?: string, c?: string) => {
      const url = swap(a ?? b ?? c ?? "");
      return url ? `${pre}"${url}"` : whole;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _q: string, v: string) => {
      const url = swap(v);
      return url ? `url("${url}")` : whole;
    });
}

export function containsMath(html: string): boolean {
  return /\\\(|\\\[/.test(html);
}
