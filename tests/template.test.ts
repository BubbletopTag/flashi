// SPDX-License-Identifier: AGPL-3.0-or-later
// Cases ported from Anki's own tests in rslib/src/{cloze,template,template_filters,typeanswer}.rs.

import { describe, expect, it } from "vitest";
import {
  clozeNumbersInString,
  extractClozeForTyping,
  revealClozeText,
  revealClozeTextOnly,
} from "../src/anki/template/cloze";
import { renderCard, renderTemplate, TemplateError } from "../src/anki/template/template";
import { stripHtml, escapeAttribute } from "../src/anki/template/text";
import { compareAnswer } from "../src/anki/template/typeanswer";
import { mediaReferences, rewriteMedia } from "../src/anki/template/render";

const fields = (o: Record<string, string>) => new Map(Object.entries(o));
const ctx = (f: Record<string, string>, frontSide: string | null = null, cardOrd = 0) => {
  const map = fields(f);
  return { fields: map, nonEmptyFields: new Set([...map].filter(([, v]) => v.trim()).map(([k]) => k)), cardOrd, frontSide };
};

describe("cloze (rslib/src/cloze.rs)", () => {
  it("finds cloze numbers", () => {
    expect(clozeNumbersInString("test")).toEqual(new Set());
    expect(clozeNumbersInString("{{c2::te}}{{c1::s}}t{{")).toEqual(new Set([1, 2]));
    expect(clozeNumbersInString("{{c0::te}}s{{c2::t}}s")).toEqual(new Set([2]));
    expect(clozeNumbersInString("{{c2::te{{c1::s}}}}t{{")).toEqual(new Set([1, 2]));
  });

  it("reveals cloze-only text", () => {
    expect(revealClozeTextOnly("foo", 1, true)).toBe("");
    expect(revealClozeTextOnly("foo {{c1::bar}}", 1, true)).toBe("...");
    expect(revealClozeTextOnly("foo {{c1::bar::baz}}", 1, true)).toBe("baz");
    expect(revealClozeTextOnly("foo {{c1::bar}}", 1, false)).toBe("bar");
    expect(revealClozeTextOnly("foo {{c1::bar}}", 2, false)).toBe("");
    expect(revealClozeTextOnly("{{c1::foo}} {{c1::bar}}", 1, false)).toBe("foo, bar");
  });

  it("extracts clozes for typing", () => {
    expect(extractClozeForTyping("{{c2::foo}}", 1)).toBe("");
    expect(extractClozeForTyping("{{c1::foo}} {{c1::bar}} {{c1::foo}}", 1)).toBe("foo, bar, foo");
    expect(extractClozeForTyping("{{c1::foo}} {{c1::foo}} {{c1::foo}}", 1)).toBe("foo");
  });

  it("handles nested clozes as plain text", () => {
    const t = "foo {{c1::bar {{c2::baz}}::qux}}";
    expect(stripHtml(revealClozeText("foo {{c1::bar {{c2::baz}}}}", 1, true))).toBe("foo [...]");
    expect(stripHtml(revealClozeText("foo {{c1::bar {{c2::baz}}}}", 1, false))).toBe("foo bar baz");
    expect(stripHtml(revealClozeText(t, 2, true))).toBe("foo bar [...]");
    expect(stripHtml(revealClozeText(t, 2, false))).toBe("foo bar baz");
    expect(stripHtml(revealClozeText(t, 1, true))).toBe("foo [qux]");
    expect(stripHtml(revealClozeText(t, 1, false))).toBe("foo bar baz");
  });

  it("renders nested clozes as HTML", () => {
    expect(revealClozeText("foo {{c1::bar {{c2::baz}}}}", 1, true)).toBe(
      `foo <span class="cloze" data-cloze="${escapeAttribute('bar <span class="cloze-inactive" data-ordinal="2">baz</span>')}" data-ordinal="1">[...]</span>`,
    );
    expect(revealClozeText("foo {{c1::bar {{c2::baz}}}}", 1, false)).toBe(
      'foo <span class="cloze" data-ordinal="1">bar <span class="cloze-inactive" data-ordinal="2">baz</span></span>',
    );
    expect(revealClozeText("foo {{c1::bar {{c2::baz}}::qux}}", 2, true)).toBe(
      'foo <span class="cloze-inactive" data-ordinal="1">bar <span class="cloze" data-cloze="baz" data-ordinal="2">[...]</span></span>',
    );
  });

  it("supports multi-ordinal clozes", () => {
    expect(clozeNumbersInString("{{c1,2::multi}}")).toEqual(new Set([1, 2]));
    expect(stripHtml(revealClozeText("{{c1,2::multi}} {{c3::x}}", 2, true))).toBe("[...] x");
  });

  it("does not let MathJax braces close a cloze", () => {
    const text = String.raw`{{c1:: \( \frac{1}{\sqrt{\pi}} \) }}`;
    expect(stripHtml(revealClozeText(text, 1, false))).toBe(String.raw` \( \frac{1}{\sqrt{\pi}} \) `);
  });
});

describe("templates (rslib/src/template.rs)", () => {
  it("renders fields, conditionals and comments", () => {
    const c = ctx({ F: "1", B: "", E: "" });
    expect(renderTemplate("{{F}}{{#F}}yes{{/F}}{{^B}}empty{{/B}}<!--{{B}}-->", c)).toBe("1yesempty<!--{{B}}-->");
    expect(renderTemplate("{{ F }} {{ #F }}x{{ /F }}", c)).toBe("1 x");
  });

  it("errors on missing fields and unbalanced conditionals", () => {
    expect(() => renderTemplate("{{Missing}}", ctx({ F: "" }))).toThrow(TemplateError);
    expect(() => renderTemplate("{{#F}}", ctx({ F: "" }))).toThrow(/Missing/);
    expect(() => renderTemplate("{{/F}}", ctx({ F: "" }))).toThrow(TemplateError);
  });

  it("supports the legacy <% %> syntax", () => {
    expect(renderTemplate("{{=<% %>=}}<%F%>", ctx({ F: "x" }))).toBe("x");
  });

  it("applies filters right to left", () => {
    expect(renderTemplate("{{text:F}}", ctx({ F: "<b>a</b>&amp;" }))).toBe("a&");
    expect(renderTemplate("{{kana:F}}", ctx({ F: "test first[second] third[fourth]" }))).toBe("testsecondfourth");
    expect(renderTemplate("{{kanji:F}}", ctx({ F: "test first[second] third[fourth]" }))).toBe("testfirstthird");
    expect(renderTemplate("{{furigana:F}}", ctx({ F: "first[second]" }))).toBe("<ruby><rb>first</rb><rt>second</rt></ruby>");
    expect(renderTemplate("{{type:F}}", ctx({ F: "x" }))).toBe("[[type:F]]");
    expect(renderTemplate("{{type:cloze:Text}}", ctx({ Text: "x" }))).toBe("[[type:cloze:Text]]");
    expect(renderTemplate("{{type:nc:ci:F}}", ctx({ F: "x" }))).toBe("[[type:nc:ci:F]]");
    expect(renderTemplate("{{tts en_US:F}}", ctx({ F: "hi" }))).toBe("[anki:tts lang=en_US]hi[/anki:tts]");
    expect(renderTemplate("{{hint:F}}", ctx({ F: "foo" }))).toContain('class=hint style="display: none">foo</div>');
    expect(renderTemplate("{{unknownfilter:F}}", ctx({ F: "kept" }))).toBe("kept");
  });

  it("renders card sides with FrontSide and clozes", () => {
    const r = renderCard("{{cloze:Text}}", "{{cloze:Text}}<br>{{Extra}}", fields({ Text: "{{c1::a}} {{c2::b}}", Extra: "e" }), 1, true);
    expect(stripHtml(r.question)).toBe("a [...]");
    expect(stripHtml(r.answer)).toBe("a be");
    const basic = renderCard("{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}", fields({ Front: "q", Back: "a" }), 0, false);
    expect(basic.answer).toBe("q<hr id=answer>a");
  });

  it("flags empty fronts and missing clozes", () => {
    expect(renderCard("{{Front}}", "{{Back}}", fields({ Front: "", Back: "a" }), 0, false).isEmpty).toBe(true);
    expect(renderCard("{{cloze:Text}}", "", fields({ Text: "{{c1::a}}" }), 1, true).isEmpty).toBe(true);
  });
});

describe("type answer (rslib/src/typeanswer.rs)", () => {
  it("marks a correct answer good", () => {
    expect(compareAnswer("abc", "abc")).toBe("<code id=typeans><span class=typeGood>abc</span></code>");
  });

  it("shows the expected answer when nothing was typed", () => {
    expect(compareAnswer("<b>a</b>&nbsp;b", "")).toBe("<code id=typeans>a b</code>");
  });

  it("diffs a wrong answer like difflib", () => {
    expect(compareAnswer("the quick brown", "the qick browns")).toBe(
      "<code id=typeans><span class=typeGood>the q</span><span class=typeMissed>-</span><span class=typeGood>ick brown</span><span class=typeBad>s</span>" +
        "<br><span id=typearrow>&darr;</span><br>" +
        "<span class=typeGood>the q</span><span class=typeMissed>u</span><span class=typeGood>ick brown</span></code>",
    );
  });

  it("can ignore case", () => {
    expect(compareAnswer("Paris", "paris", true)).toBe("<code id=typeans><span class=typeGood>Paris</span></code>");
  });
});

describe("media references", () => {
  it("finds and rewrites src and url() references", () => {
    const html = `<img src="a b.png"><img src='c.jpg'><img src=d.gif><img src="https://x/y.png"><div style="background:url('e.svg')">`;
    expect(mediaReferences(html).sort()).toEqual(["a b.png", "c.jpg", "d.gif", "e.svg"]);
    const out = rewriteMedia(html, new Map([["a b.png", "data:1"], ["e.svg", "data:2"]]));
    expect(out).toContain('src="data:1"');
    expect(out).toContain('url("data:2")');
    expect(out).toContain("https://x/y.png");
  });
});
