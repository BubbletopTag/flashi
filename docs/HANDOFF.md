# Flashi — Session Handoff (2026-10-31)

> **2026-10-31 update:** Read [IMPLEMENTATION.md](IMPLEMENTATION.md) first for
> the current implementation, verification, and remaining external checks. The
> status tables and remaining-work list below describe the original handoff.

> For the next Claude Code session. Read this first, then `docs/SPEC.md` (the original
> build brief, unchanged). Everything below is committed on `main` of `BubbletopTag/flashi`.

## Instructions for the next session — start here

1. Work directly on `main` and commit/push as you go (Aiden asked for this; the repo is new).
2. Run `npm ci`, then `npm test` and `npm run typecheck` to confirm a green baseline.
3. Ask Aiden what happened when he tried the published artifact (see "Artifact" below) and
   fix anything broken **before** new work.
4. Continue with "Remaining work" in order. Only stop for items marked **Decision**.

## Status at a glance

| Area | State |
|---|---|
| Phase 0 — scaffold, two builds, Vitest, Playwright dep | Mostly done. Missing: README (§10), NOTICE.md, `.github/workflows/*`, `golden/ANKIDROID_REF`, Playwright config/e2e tests. |
| Phase 1 — scheduler | **Done and verified** against the official `anki` package (bit-exact). |
| Phase 1 — `.apkg` import/export | **Done and verified** (all formats; export round-trips into official Anki). |
| Phase 1 — template engine / rendering | Done (ported Anki tests pass). Image occlusion not supported. |
| Phase 1 — UI | Deck picker, reviewer, congrats, settings, about, drawer, FAB, dialogs, snackbar. Working end to end in Chromium. |
| Phase 1 — storage | IndexedDB + pending-answers journal + backup nudge + export. Working in Chromium. |
| Phase 1 — artifact | Published (private), **not yet confirmed working inside claude.ai** (WASM/CSP, file input, downloads). |
| Phase 2 — golden frames | Not started (token files + golden build mode exist). |
| Phase 3 — PWA | Not started (`build:pwa` builds but there is no manifest/SW/OPFS yet). |

Tests: `npm test` → 81 pass, 5 skipped (the skipped ones compare live against official Anki
and run when `FLASHI_ANKI_PYTHON` points at a Python with `anki` installed — see below).

## Artifact

- URL: https://claude.ai/artifact/FhaqTMJN5vvWD25xQWbfCX (private, owner only), version 1.
- Built from commit `3fd0fd8` with `npm run build:artifact` → `dist/flashi.html` (~4.9 MB).
- Declared capability: `downloads` (export). To update it from a new session, publish
  `dist/flashi.html` with `url` set to the link above (read it first, as the tool requires).
- Unverified inside claude.ai: WebAssembly instantiation under the artifact CSP, the
  `<input type="file">` picker, `claude.use("downloads")`, IndexedDB persistence.
  If WASM is blocked the page shows "Flashi couldn't start: …".

## How to run things

```bash
npm ci
npm test                      # vitest
npm run typecheck             # tsc (TypeScript 7)
npm run build:artifact        # dist/flashi.html (single file, WASM + MathJax inlined)
npm run build:pwa             # dist-pwa/ (Phase 3 work still needed)
npx vite build --mode golden  # dist-golden/flashi.html, includes ?theme=golden

# Live comparisons against official Anki (also used to regenerate fixtures):
python3 -m venv .venv && .venv/bin/pip install anki genanki
FLASHI_ANKI_PYTHON=.venv/bin/python npm test
TZ=America/Los_Angeles .venv/bin/python scripts/make-logic-goldens.py   # fixtures/logic-goldens.json
TZ=America/Los_Angeles .venv/bin/python scripts/make-fixtures.py        # fixtures/decks/*, src/anki/defaults.json
npx tsx scripts/make-flashi-theme.mjs                                   # src/theme/tokens.flashi.css
```

Playwright: the container had Playwright 1.63.0 preinstalled, so `@playwright/test` is pinned
to `1.63.0`. Screenshots in `docs/screenshots/` were taken with an ad-hoc script (serve `dist/`
with `python3 -m http.server`, viewport 393×852 @2x, `setInputFiles("#import-file", …)`).
That script should become `e2e/*.spec.ts` + `playwright.config.ts`.

## Verified facts (checked against upstream source / official Anki)

- `rand` used by rslib is **0.10.1**: `StdRng` = ChaCha12 (chacha20 crate), `seed_from_u64`
  = PCG32 expansion. Fuzz factor = `StdRng::seed_from_u64(card.id + card.reps)` then
  `random_range(0.0..1.0)` as f32. Ported in `src/anki/rng.ts`, matches rand's test vectors.
- All scheduler arithmetic is f32 in Rust; the port uses `Math.fround` everywhere.
- **Load balancer is ON by default** (`loadBalancerEnabled` defaults true) and changes review
  intervals ≤ 90 days. Ported. Its card query counts *any* card with `due` in
  `[today, today+99)` (including new cards' positions) — an upstream quirk, kept.
- New-card labels with defaults: `<1m · <6m · <10m · 3d` — Easy is **fuzzed** (the spec's
  "Easy 4 d" ignored fuzz). Labels come wrapped in Unicode isolation marks upstream; stripped.
- Learning steps get up to +25% (max 5 min) fuzz via `random_range(secs..upper)` (Canon's method).
- Early reviews log revlog type 3 ("Filtered"), as upstream does.
- Package layout written with "Support older Anki versions": `meta` (`08 02`, stored),
  `collection.anki21` (deflate), `collection.anki2` placeholder (stored), media `0..n`
  (stored), `media` JSON (stored). Current default export: `collection.anki21b` +
  zstd media + protobuf `MediaEntries`.
- Schema-18 files are **WAL** (header bytes 18/19 = 2); must be patched to 1 before
  `sqlite3_deserialize` (done in `src/anki/sqlite.ts`). `fields`/`templates` tables need the
  `unicase` collation even for `SELECT *` (registered via `sqlite3_create_collation_v2`).
- Schema-11 JSON contains 64-bit template/field ids → `src/anki/json.ts` preserves them.
- AnkiDroid at the pinned ref (`89e5dbeabb7b3b97262aa87b8671c10c2e847139`): the **legacy
  Reviewer is the default** (`newReviewerOptions` defaults false; `ReviewerScreenshotTest`
  captures the legacy one). Legacy footer buttons are flat rectangles (the 12 dp radius is the
  new reviewer's). The **Show answer bar uses `hardButtonRef` (#455A64)**, not blue_700.
- AnkiDroid hides the reviewer title (`showDeckTitle` false) and ETA (`showETA` false) by
  default. Flashi shows both (spec asks for them) with switches in Settings; the golden
  harness should turn them off.
- AnkiDroid's default type-answer mode (`useInputTag` false) shows
  `<span id="typeans" class="typePrompt">........</span>` in the card plus a native input bar
  below it; Flashi does the same.
- claude.ai `downloads` allowlist has **no `.apkg`**; artifact exports are `.zip`. Anki
  desktop's importer accepts `.zip` as an apkg (`ApkgImporter.accepted_file_endings`).
- `?inline` doesn't work for `.wasm` in Vite 8; a virtual module embeds it as base64.

## Decisions taken (defaults; note in PRs)

| Decision | Taken |
|---|---|
| UI library | Preact 11 (JSX via tsconfig `jsxImportSource`, no Babel preset) |
| Palette | M3 tonal spot from `#8BC34A`; counts bar lightened to tone 94 and review count darkened to `#1B5E20` so all text passes 4.5:1. **Decision:** Aiden may tweak. |
| Viewport | 393×852 |
| Import size | reject > 500 MB, confirm > 100 MB |
| Internal schema | schema-11 SQLite |
| Import with scheduling | always (keeps backups intact). Deck presets: target's existing presets win. Empty Default deck not imported. Filtered decks → normal decks. Media name clash with different content → `name-<sha1:8>.ext`, note fields rewritten. |
| Export | whole collection, referenced media only (+ `_`-prefixed files) |
| MathJax | 3.2.2 `tex-svg.js`: inlined in artifact, separate file for PWA, injected only into cards containing `\(` or `\[` |
| Card media in sandboxed frame | rewritten to `data:` URLs (no blob/postMessage needed); audio plays in the parent frame (user activation) |
| Golden theme | only in dev/test and `--mode golden` builds (`dist-golden/`), stripped from artifact/PWA |
| Not ported yet | FSRS, filtered decks/custom study, image occlusion, LaTeX images, add-on filters (ignored), whiteboard |

## File map

```
src/anki/rng.ts                 ChaCha12/PCG32, rand float/int/WeightedIndex sampling, fnvhash
src/anki/scheduler/states.ts    SM-2 state machine (states/*.rs), steps, fuzz
src/anki/scheduler/answering.ts current state from card, apply answer, revlog, labels
src/anki/scheduler/loadBalancer.ts, timing.ts, timespan.ts, limits.ts, deckTree.ts, queue.ts
src/anki/collection.ts          schema-11 collection: decks, counts, queue, answer, bury/suspend/flag, undo, congrats
src/anki/config.ts              typed schema-11 deck/preset JSON
src/anki/apkg/{zip,protobuf,schema18,import,export}.ts
src/anki/template/{template,cloze,text,typeanswer,render}.ts
src/anki/sqlite.ts              official SQLite WASM wrapper (+ unicase, fnvhash)
src/anki/defaults.json          new-collection JSON from official anki (scripts/make-fixtures.py)
src/storage/{store,media}.ts    IndexedDB / memory backends, journal
src/platform/                   wasm + mathjax sources per build, files.ts (downloads capability / <a download>)
src/app/                        App.tsx, controller.ts, ui.tsx, cardFrame.ts, audio.ts
src/screens/                    DeckPicker, Reviewer, Congrats, Settings (+About)
src/theme/                      tokens.flashi.css (generated), tokens.golden.css, base.css, icons.ts (from AnkiDroid drawables)
scripts/                        make-fixtures.py, make-logic-goldens.py, check-export.py, queue-golden.py, make-flashi-theme.mjs
fixtures/                       logic-goldens.json, decks/*.apkg
tests/                          scheduler.goldens, queue, apkg, template
docs/                           SPEC.md, HANDOFF.md, screenshots/
```

## Remaining work (in order)

1. **Confirm the artifact works in claude.ai** (ask Aiden). Likely risks: WebAssembly blocked
   by CSP (would need `wasm-unsafe-eval`; fallback idea: asm.js SQLite build), file input,
   downloads. Fix and republish to the same URL.
2. **Phase 0 leftovers:** README.md exactly per SPEC §10 (replace the starter), NOTICE.md
   listing every upstream source/library (Anki AGPL, AnkiDroid GPL incl. layouts/icons/
   `flashcard.css`/`SoundUtils.kt` markup/`TypeAnswer.kt` placeholder/ETA from libanki,
   rand/rand_core/chacha20 MIT-or-Apache, Python difflib algorithm, SQLite WASM, Preact,
   fflate, fzstd, MathJax, material-color-utilities, Roboto), `golden/ANKIDROID_REF`,
   `.github/workflows/ci.yml` (typecheck, test with `pip install anki`, both builds),
   `goldens.yml` (per SPEC §9), `pages.yml`.
3. **e2e tests** (`playwright.config.ts`, `e2e/`): import fixture → study 20 cards → reload →
   progress intact → export → re-import; run against `dist/flashi.html` served over http.
4. Small known issues:
   - `src/screens/Congrats.tsx`: "next learning card ready in" uses an awkward
     `answerButtonTime(...).replace(...)` chain — replace with a minutes/hours helper.
   - `build:artifact` also emits an unused `dist/sqlite3-worker1-*.js`; harmless, could be excluded.
   - Deck rows with subdecks look slightly over-indented vs AnkiDroid — verify in Phase 2.
   - Studied-today line can sit under the snackbar.
   - No confirm for "Delete all data" UI yet (controller has `deleteAllData()`, not wired).
   - Undo after bury/suspend rebuilds the queue (card is pushed to front only for answers).
5. **Acceptance (SPEC Phase 1):** real AnkiWeb shared deck (text+images+audio) from Aiden;
   decks exported from current Anki desktop with/without "Support older Anki versions";
   study 20; reload; export → Anki desktop import with scheduling (already automated via
   `scripts/check-export.py` in `tests/apkg.test.ts`).
6. **Phase 2 golden frames** per SPEC §9 (fixture JSON, extra Roborazzi tests, `npm run golden`).
7. **Phase 3 PWA**: manifest, icons (original light-green; `FlashiLogo` in `src/app/ui.tsx`
   is a starting point), service worker + update prompt, OPFS (`opfs-sahpool`) backend,
   `navigator.storage.persist()`, backup ring, Add-to-Home-Screen hint, Pages deploy, self-hosted Roboto.
8. Optional Phase 1b: mirror review log to the artifact `db` capability.
