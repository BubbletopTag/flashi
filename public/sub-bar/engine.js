/* Sub Bar engine: turns a typed English answer into a score. No DOM, so it also runs in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubBarEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Words that turn "jalapeños" into "extra jalapeños". Stored the way tokens look after stemming.
  const MODIFIERS = {
    en: new Set(['extra', 'more', 'double', 'lot', 'plenty', 'heavy', 'additional', 'another']),
    es: new Set(['mas', 'extra', 'doble', 'mucho', 'mucha', 'bastante', 'adicional', 'otro', 'otra']),
  };
  // What a player types when they ask for the order again in English instead of Spanish.
  const ENGLISH_ASK = new Set(['repeat', 'slow', 'slower', 'slowly', 'again']);
  const ASK_SLOW = ['despacio', 'lento', 'lentamente'];
  const ASK_REPEAT = ['repetir', 'repita', 'repite', 'repetirlo', 'repetirla', 'repetirlas'];

  // Lowercase, drop accents and punctuation, split into words. "Jalapeños!" -> ["jalapenos"]
  function words(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  }

  // Cheap plural stripping, enough for this menu: tomatoes -> tomato, pickles -> pickle, hummus stays hummus.
  function stem(w) {
    if (w.length <= 3) return w;
    if (/(oes|ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
    if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }
  const tokens = s => words(s).map(stem);

  // Edit distance that counts a swapped pair of letters as one slip ("provolnoe").
  function osa(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[m][n];
  }

  // Typos are forgiven on longer words only, so "ham" and "what" can never match something else.
  function same(typed, want) {
    if (typed === want) return true;
    if (typed.length < 5 || want.length < 5) return false;
    return osa(typed, want) <= (want.length >= 9 ? 2 : 1);
  }

  // Find phrases in the typed words. Longer phrases go first and each word is used once, so
  // "spinach tortilla" is not also counted as spinach on the sandwich.
  function scan(typed, patterns, used, only) {
    const hits = [];
    for (const p of patterns) {
      if (only && !only.has(p.id)) continue;
      const L = p.t.length;
      for (let i = 0; i + L <= typed.length; i++) {
        let ok = true;
        for (let k = 0; k < L; k++) if (used[i + k] || !same(typed[i + k], p.t[k])) { ok = false; break; }
        if (!ok) continue;
        for (let k = 0; k < L; k++) used[i + k] = true;
        hits.push(p.id);
        i += L - 1;
      }
    }
    return hits;
  }

  // lang "en" grades what a player types in English (server mode); "es" grades Spanish (customer mode).
  function create(menu, opts) {
    const es = !!opts && opts.lang === 'es';
    const mods = es ? MODIFIERS.es : MODIFIERS.en;
    const full = [], part = [], label = {}, bare = {};
    for (const item of menu) {
      label[item.id] = es ? item.esLabel : item.en;
      bare[item.id] = es ? item.esBare : item.en;
      for (const s of (es ? item.es : item.syn)) full.push({ id: item.id, t: tokens(s) });
      for (const s of (es ? item.esPartial : item.partial) || []) part.push({ id: item.id, t: tokens(s) });
    }
    const longestFirst = (a, b) => b.t.length - a.t.length || b.t.join('').length - a.t.join('').length;
    full.sort(longestFirst);
    part.sort(longestFirst);
    const hasPartial = new Set(part.map(p => p.id));

    const labelOf = id => !id.startsWith('more:') ? label[id]
      : es ? 'un poco más de ' + bare[id.slice(5)] : 'extra ' + label[id.slice(5)];

    // Did they ask the customer to repeat or slow down? Spanish only, accents optional.
    function askKind(raw) {
      const has = list => raw.some(w => list.some(x => same(w, x)));
      if (has(ASK_SLOW)) return 'slow';
      if (has(ASK_REPEAT) || (raw.includes('otra') && raw.includes('vez'))) return 'repeat';
      return null;
    }

    // "ask": a Spanish request. "english-ask": they asked in English, which the customer can't follow.
    // "answer": everything else.
    function classify(text) {
      const raw = words(text);
      const ask = askKind(raw);
      if (ask) return { kind: 'ask', ask };
      const t = raw.map(stem);
      if (t.some(w => ENGLISH_ASK.has(w))) {
        const used = new Array(t.length).fill(false);
        if (!scan(t, full, used).length) return { kind: 'english-ask' };
      }
      return { kind: 'answer' };
    }

    // order.want lists item ids, plus "more:<id>" for "a little more of <id>".
    // Right item: 1 point. Right kind of wrap but not which: half. An item that wasn't ordered: -1.
    // Asking the customer to repeat caps the order at 90. Answering after the clock ran out halves it.
    function grade(order, text, opts) {
      const typed = tokens(text);
      const used = new Array(typed.length).fill(false);
      const got = new Set(scan(typed, full, used));
      const items = order.want.filter(id => !id.startsWith('more:'));
      const needPartial = new Set(items.filter(id => !got.has(id) && hasPartial.has(id)));
      const partialGot = needPartial.size ? new Set(scan(typed, part, used, needPartial)) : new Set();
      const modifier = typed.some(w => mods.has(w));

      const matched = [], partial = [], missed = [];
      for (const id of order.want) {
        if (id.startsWith('more:')) (got.has(id.slice(5)) && modifier ? matched : missed).push(id);
        else if (got.has(id)) matched.push(id);
        else if (partialGot.has(id)) partial.push(id);
        else missed.push(id);
      }
      const wrong = [...got].filter(id => !order.want.includes(id));
      const raw = (matched.length + 0.5 * partial.length - wrong.length) / order.want.length;
      let score = Math.max(0, Math.min(1, raw)) * 100;
      if (opts && opts.asked) score *= 0.9;
      if (opts && opts.late) score *= 0.5;
      return { score: Math.round(score), matched, partial, missed, wrong };
    }

    return { grade, classify, labelOf };
  }

  return { create, words, stem };
});
