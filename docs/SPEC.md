# Flashi — Build Brief for Claude Code

> Hand-off spec written 2026-10-30. Owner: Aiden (GitHub: **BubbletopTag**).
> Working name **Flashi**. Sorry, I'll think of a better name eventually.

## Instructions for Claude Code — start here

Aiden pasted this whole document as the first message of this session. The repo is **`BubbletopTag/flashi`** (created with `gh repo create`; it already has a starter `README.md` and the AGPL-3.0 `LICENSE`).

1. Save this entire document, unchanged, as `docs/SPEC.md` in the repo. Commit it with the message `Add build spec` and push it (on your working branch if the session uses one; include it in your first PR).
2. Read it end to end.
3. Do Phase 0 and Phase 1.
4. Before writing any code that parses Anki files or schedules cards, verify the relevant claims in §6–§7 against the Anki/AnkiDroid source — they are hints, not gospel.
5. Only stop to ask Aiden about items marked **Decision**; otherwise take the default and note it in the PR.

---

## 1. What we're building

A free, open-source, mobile-first flashcard **web app** that looks and behaves like **AnkiDroid**, runs on iPhone from the Home Screen (no App Store, no sideloading), works offline, and imports/exports Anki decks (`.apkg`).

Why: the official iOS app is paid and AnkiDroid is Android-only. A faithful web port of AnkiDroid's UI gives iPhone users — and everyone else — a free option.

**Not in scope yet:** AnkiWeb sync, add-ons, tablet/desktop layouts, card template editor, image occlusion editor.

## 2. Ground rules

### License
- Whole repo: **AGPL-3.0-or-later**.
  - AnkiDroid is GPL-3.0-or-later; Anki (rslib scheduler, template engine, `.proto` files) is AGPL-3.0-or-later. GPLv3 §13 explicitly allows combining GPLv3 and AGPLv3 code, so AGPL lets us port from both.
  - AGPL's network clause is easy for a web app: public repo + a "Source code" link in About.
- Keep upstream copyright/SPDX headers on anything ported. List every upstream source and library in `NOTICE.md`.
- New dependencies: prefer MIT / Apache-2.0 / ISC / BSD.

### Trademarks and branding
- Never use "Anki", "AnkiDroid", "AnkiMobile", "AnkiWeb" or the star logo as the app's name, icon, title or wordmark. Descriptive use is fine ("Imports Anki `.apkg` decks").
- README and About carry: *"Flashi is not affiliated with or endorsed by Ankitects Pty Ltd or the AnkiDroid project."*
- App icon: original design, light green.

### Two themes, one token system
All colors and dimensions are CSS custom properties; a theme is one token file.

| Theme | Where it appears | Look |
|---|---|---|
| `flashi` | Default; the **only** theme in published builds (artifact and PWA) | Light green. Generate a Material 3 tonal palette from seed `#8BC34A` with `@material/material-color-utilities` (Apache-2.0) so on-colors pass contrast. Keep answer-button semantics (Again red, Hard gray, Good green, Easy blue) — those are functional, not branding. **Decision:** Aiden may tweak. |
| `golden` | Dev/test only (`?theme=golden`), stripped from production builds | AnkiDroid's original Light theme, exact values (§5). Used only to diff against golden frames. The title text still says "Flashi" and that region is masked in diffs — AnkiDroid's name/logo is never rendered. |

## 3. Phases

### Phase 0 — Repo setup
- Vite + TypeScript (strict). UI: **Preact** (small, fast) — **Decision**, default Preact.
- Two builds from one source:
  - `npm run build:artifact` → `dist/flashi.html`: one self-contained file, everything inlined including WASM as base64 (e.g. `vite-plugin-singlefile`).
  - `npm run build:pwa` → `dist-pwa/` for GitHub Pages.
- Vitest (unit), Playwright (golden + e2e).
- Files: `LICENSE` already exists — keep it (confirm it's the AGPL-3.0 text). Replace the starter `README.md` with §10. Add `NOTICE.md`. `docs/SPEC.md` comes from step 1 above.

Suggested layout:
```
src/
  app/            routing, shell, toolbar, drawer, FAB
  screens/        deck-picker, reviewer, congrats, settings, (later) browser, editor
  anki/           apkg import/export, schema, template engine, cloze, scheduler, queue
  storage/        CollectionStore + idb backend + opfs backend
  platform/       artifact.ts (claude.use capabilities), pwa.ts (sw, install hint)
  theme/          tokens.flashi.css, tokens.golden.css, ripple.css, icons/ (SVG)
public/           manifest, icons, service worker (PWA build only)
fixtures/         golden-fixture.json, generated .apkg test decks
scripts/          make-fixtures.py, make-logic-goldens.py
golden/           ANKIDROID_REF, android/*.png, masks/*.json, extra-tests/*.kt, report/
tests/            vitest specs
.github/workflows/ ci.yml, goldens.yml, pages.yml
```

### Phase 1 — Artifact MVP (ship first)
1. **Import `.apkg`** (legacy and current formats, §6) with progress UI and graceful errors.
2. **Deck list** (DeckPicker clone): nested decks with expand/collapse, New / Learning / Due counts, tap deck → study, empty state, FAB speed dial (Create deck, Import).
3. **Reviewer** clone: toolbar (deck name, time left, undo, flag, overflow), counts bar, card frame, Show Answer button, four answer buttons with next-interval labels, bury / suspend / flag in overflow.
4. **SM-2 scheduler** matching Anki's v3 scheduler with the default preset (§7).
5. **Congrats** screen when nothing is due.
6. **Storage** in IndexedDB (§8) + **Export backup** (`.apkg` with scheduling) + "last backup N days ago" nudge.
7. **Settings / About**: storage used, export, licenses, source link.

Artifact rules (claude.ai):
- Load the `artifact-design` and `artifact-capabilities` skills before writing the page.
- One self-contained HTML ≤ 16 MB. External scripts only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm, unpkg.com — but prefer inlining everything. Stylesheets only from Google Fonts.
- Wrap every storage call in try/catch; the page must render even if storage throws or comes back empty.
- Export through `await claude.use("downloads")` (`null` → fall back to `<a download>`).
- Confirm `<input type="file">` works inside the artifact frame. If it doesn't, import through the `assets` capability.
- If your session has no Artifact tool, deliver `dist/flashi.html` and Aiden will publish it from a claude.ai chat.

**Acceptance:** import a real AnkiWeb shared deck (text + images + audio), plus decks exported from current Anki desktop both with and without "Support older Anki versions"; study 20 cards; reload → progress intact; export → import into Anki desktop → scheduling preserved.

### Phase 2 — Golden frames
See §9. Goal: every canonical screen within its diff budget in `golden` theme.

### Phase 3 — PWA on GitHub Pages
- `manifest.webmanifest` (name Flashi, `display: standalone`, green theme color, icons incl. 180×180 `apple-touch-icon`), `apple-mobile-web-app-*` meta.
- Service worker precaching the whole app (offline-first) with an "update available" prompt.
- Storage upgrade (§8): SQLite in OPFS + media in OPFS, `navigator.storage.persist()`, automatic backup ring (keep last 5) + manual export.
- In a Safari tab (`navigator.standalone === false`), show a one-time "Add to Home Screen" hint explaining why (data safety).
- `pages.yml` workflow deploys `dist-pwa/`.

### Phase 4 — Parity backlog
Card browser · note editor / add note · deck options screen · FSRS (`ts-fsrs`, MIT; read/write Anki's FSRS card data) · statistics · dark theme (+ `+night` goldens) · gestures/tap zones matching AnkiDroid's defaults · `{{tts:}}` via `speechSynthesis` · type-in answers · filtered decks / custom study · i18n (AnkiDroid's translations are GPL) · whiteboard.

**Sync:** AnkiWeb from a browser is almost certainly blocked by CORS. Possible later routes: a self-hosted Anki sync server behind a CORS-enabled proxy, or file-based sync. Research before promising anything.

## 4. iOS Safari facts that drive the design

- Since iOS 17, a browser origin can use up to ~60% of total disk; Home Screen web apps get the same quota. ([WebKit][webkit-storage])
- A cross-origin frame — which is what an artifact inside claude.ai is — gets about 10% of the main frame's quota. ([WebKit][webkit-storage])
- In Safari tabs, script-writable storage (IndexedDB, localStorage, OPFS, …) is deleted after 7 days of Safari use without a visit. Home Screen web apps keep their own day counter, so in practice their data stays. ([Search Engine Land][sel-7day]) ⇒ artifact and Safari-tab users must be nudged to export; the installed PWA is the real home.
- `navigator.storage.estimate()` and `persist()` are supported (Safari 17+). ([MDN][mdn-quota])
- Layout: `viewport-fit=cover` + `env(safe-area-inset-*)`, `100dvh`, `touch-action: manipulation` (no double-tap zoom), `-webkit-tap-highlight-color: transparent`, Material-style ripple on taps.

## 5. UI source of truth (AnkiDroid repo)

Clone `ankidroid/Anki-Android` at the pinned ref (§9). Units: **1 dp = 1 CSS px**; sp → px at font scale 1.0. Font: **Roboto** (Apache-2.0), self-hosted woff2 for the PWA. Icons: convert AnkiDroid's vector drawables (`pathData` in `res/drawable/*.xml`) to inline SVG for an exact match.

| Screen | Files |
|---|---|
| Deck list | `AnkiDroid/src/main/res/layout/include_deck_picker.xml`, `item_deck.xml`; `AnkiDroid/src/main/res/values/dimens.xml` |
| Reviewer (legacy) | `activity_reviewer.xml`, `include_reviewer_topbar.xml`, `include_reviewer_flashcard.xml`, `include_reviewer_answer_buttons.xml` |
| Reviewer (new Material) | `fragment_reviewer.xml`, `view_answer_area.xml`, `view_reviewer_menu.xml` |
| Theme | `common/android/src/main/res/values/theme_light.xml`, `theme_colors.xml`, `colors.xml`, `theme_dimens.xml`, `theme_styles.xml` |
| Strings | `AnkiDroid/src/main/res/values/*.xml` |

AnkiDroid is mid-migration between reviewers. Match whichever one is **default** at the pinned ref — check which one `ReviewerScreenshotTest` captures.

Golden tokens, read from `theme_light.xml` / `colors.xml` / `dimens.xml` on 2026-10-30 (re-check at the pinned ref):
```css
:root[data-theme="golden"] {
  --primary: #03A9F4;          /* colorPrimary = material_light_blue_500 (toolbar) */
  --primary-dark: #0288D1;     /* colorPrimaryDark */
  --accent: #455A64;           /* colorAccent = material_blue_grey_700 */
  --window-bg: #FFFFFF;
  --surface-variant: #D6ECFA;
  --current-deck-bg: #ECECEC;
  --count-new: #303F9F;        /* newCountColor = indigo_700 */
  --count-learn: #D32F2F;      /* learnCountColor = red_700 */
  --count-review: #2E7D32;     /* reviewCountColor = green_800 */
  --topbar: #B3E5FC;           /* reviewer counts bar = light_blue_100 */
  --btn-again: #D32F2F; --btn-hard: #455A64; --btn-good: #4CAF50; --btn-easy: #03A9F4;
  --btn-text: #FFFFFF;
  --show-answer: #1976D2;      /* showAnswerButtonBackground = blue_700 */
  --answer-btn-radius: 12px; --answer-btn-margin-x: 3px; --answer-btn-font: 14px;
  --reviewer-side-margin: 8px; --deck-picker-left-padding: 24px;
  --flag-red: #FF4747; --flag-orange: #FFB647; --flag-green: #6FF06F; --flag-blue: #5289FF;
  --flag-pink: #FF99F1; --flag-turquoise: #85FFEF; --flag-purple: #C398EC;
}
```

## 6. Anki file formats — verify before coding

Authoritative sources in `ankitects/anki`: `rslib/src/import_export/package/` (apkg import/export, `meta.rs`, `media.rs`), `rslib/src/storage/schema11.sql`, `rslib/src/storage/upgrades/`, `proto/anki/*.proto`. AnkiDroid's `libanki/` module mirrors much of this in Kotlin.

My understanding (hints only):
- `.apkg` is a zip. Collection entry, preferred in this order:
  - `collection.anki21b` — zstd-compressed SQLite, schema 18 (current default export).
  - `collection.anki21` — SQLite, schema 11 (legacy export).
  - `collection.anki2` — SQLite, schema 11; in newer packages it's a stub whose only card tells old clients to update.
- `meta` (new packages): protobuf `PackageMetadata` with a version enum.
- `media`: legacy = JSON `{"0": "img.jpg", …}`; new = zstd-compressed protobuf `MediaEntries` (name, size, sha1). Media members are named `0`, `1`, …; in new packages each is zstd-compressed.
- Schema 11: single-row `col` with JSON columns (`models`, `decks`, `dconf`, `conf`, `tags`); `notes` (`flds` joined by `\x1f`), `cards`, `revlog`, `graves`.
- Schema 18: `notetypes`, `fields`, `templates`, `decks`, `deck_config`, `config`, `tags` tables; `config`/`kind` columns are protobuf blobs (decode with protobufjs + Anki's `.proto`). Some text columns use a custom **`unicase` collation** — register a case-insensitive Unicode collation or statements touching them fail. Check which SQLite WASM build exposes collation registration (the official `@sqlite.org/sqlite-wasm` C-API vs sql.js).
- **Decision** (default): keep the collection internally as **schema-11 SQLite** (convert schema 18 on import). Export in exactly the format current Anki writes with "Support older Anki versions" ticked, so every Anki client can import it.
- Card enums: `type` 0 new · 1 learning · 2 review · 3 relearning. `queue` −3 manually buried · −2 sibling buried · −1 suspended · 0 new · 1 learning (`due` = epoch seconds) · 2 review (`due` = days since `col.crt`) · 3 day-learning (`due` = day number) · 4 preview. `factor` in permille (2500 = 250%). `revlog.id` = ms timestamp, `ease` 1–4, `ivl` days (negative = seconds), `type` 0 learn · 1 review · 2 relearn · 3 filtered · 4 manual · 5 rescheduled. FSRS memory state lives in `cards.data` JSON.

**Fixtures:** generate test decks in both formats with the official `anki` PyPI package (AGPL; `pip install anki`), and with genanki (MIT) for odd legacy cases. Aiden can supply popular AnkiWeb shared decks for real-world tests.

## 7. Scheduler and card rendering

### SM-2 (Anki v3 scheduler), default preset
| Option | Default |
|---|---|
| New cards/day | 20 |
| Max reviews/day | 200 |
| Learning steps | 1m 10m |
| Graduating interval | 1 d |
| Easy interval | 4 d |
| Relearning steps | 10m |
| Minimum interval | 1 d |
| Leech threshold | 8 lapses (tag `leech`) |
| Maximum interval | 36500 d |
| Starting ease | 2.50 |
| Easy bonus | 1.30 |
| Interval modifier | 1.00 |
| Hard interval | 1.20 |
| New interval (after lapse) | 0.00 |
| Next day starts at | 4:00 local |
| Learn-ahead limit | 20 min |
| Bury siblings | off |

Expected labels on a new card with defaults: Again < 1 min · Hard < 6 min · Good < 10 min · Easy 4 d (exact text format comes from the goldens).

Port the logic from `rslib/src/scheduler/states/` (AGPL is fine), including fuzz (`fuzz.rs`), which is seeded deterministically.

**Logic goldens:** a script using the official `anki` package produces expected scheduling states for scenarios (new card × each button, learning progression, graduation, lapses, ease changes, hard/easy on reviews, overdue reviews) → JSON in `fixtures/` → Vitest asserts Flashi matches. API names to verify: something like `col.sched.get_scheduling_states` / `describe_next_states`.

**Queue (MVP):** intraday learning due now → day-learning and reviews due (respect limits, children inherit) → new up to limit → learning within learn-ahead. Full v3 ordering options later.

### Rendering
- Template engine subset, ported from `rslib/src/template.rs` and `cloze.rs`: `{{Field}}`, `{{FrontSide}}`, `{{#F}}…{{/F}}`, `{{^F}}…{{/F}}`, filters `text:`, `hint:`, `type:`, `cloze:` (`{{c1::answer::hint}}`), `furigana:`/`kana:`/`kanji:`, `tts:`, specials `{{Tags}} {{Deck}} {{Subdeck}} {{Card}} {{Type}}`.
- Wrap card HTML the way AnkiDroid's WebView page does (body classes such as `card cardN`, night-mode classes) — find AnkiDroid's card HTML wrapper in its assets and copy its structure.
- `[sound:x.mp3]` → AnkiDroid-style play button; autoplay setting. MathJax 3 for `\(…\)` / `\[…\]` (inline for artifact, bundle for PWA).
- **Security:** decks are untrusted HTML/JS. Render each card in an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin`, so card scripts can't read storage. Parent `blob:` URLs may not resolve inside an opaque-origin frame — pass Blobs via `postMessage` and create URLs inside the frame, or use `data:` URLs.

## 8. Storage

One `CollectionStore` interface, two backends:

- **Artifact / Safari tab:** SQLite WASM in memory; debounced save of the serialized DB bytes to IndexedDB after each answer and on `visibilitychange`/`pagehide`; media blobs in IndexedDB. On failure, show a banner: storage unavailable, export to keep progress.
- **PWA:** official SQLite WASM with the `opfs-sahpool` VFS in a Worker (it doesn't need COOP/COEP headers, which GitHub Pages can't set — verify), media in OPFS, `navigator.storage.persist()`, show `estimate()` in Settings.
- **Never lose answers:** keep a small pending-answers journal so a crash between answering and saving replays on next load.
- **Optional Phase 1b:** mirror the review log + card states to the artifact `db` capability for the signed-in owner (private path `data/users/<id>/…`). It's a small database — no media, no full collection.

## 9. Golden frames

### Where they come from
AnkiDroid already has **Roborazzi screenshot tests** (Robolectric on the JVM — no emulator, no KVM, no Waydroid):

- Tests: `AnkiDroid/src/test/java/com/ichi2/anki/*ScreenshotTest.kt` — DeckPicker, Reviewer, NavigationDrawer, StudyOptions, CardBrowser, NoteEditor, Dialog, and more.
- Base class `ScreenshotTest.kt`: phone = `RobolectricDeviceQualifiers.MediumPhone`; dark = `+night`.
- Record: `./gradlew robolectricSdkDownload compileScreenshotTests -Pscreenshot` (warm-up), then `./gradlew recordScreenshots -Pscreenshot` (JDK 21). Output: `**/build/outputs/roborazzi/<TestClass>/<name>.png`.
- Their CI (`.github/workflows/screenshot_store.yml`) uploads these as the Actions artifact **`screenshot`** on every push to main (30-day retention).

### Getting them
- **Quick look:** `gh run list -R ankidroid/Anki-Android --workflow screenshot_store.yml --branch main --status success -L 1 --json databaseId`, then `gh run download <id> -R ankidroid/Anki-Android -n screenshot -D golden/upstream` (needs gh auth).
- **Reproducible (use this):** `.github/workflows/goldens.yml` in the Flashi repo, `workflow_dispatch` with an `ankidroid_ref` input defaulting to `golden/ANKIDROID_REF`:
  1. Checkout `ankidroid/Anki-Android@<ref>` into `ankidroid/`.
  2. Setup JDK 21 (jetbrains distribution) and Gradle.
  3. Copy `golden/extra-tests/*.kt` into `ankidroid/AnkiDroid/src/test/java/com/ichi2/anki/flashi/`.
  4. Run the two gradle commands above.
  5. Upload the PNGs and open a PR committing them to `golden/android/`.

  GitHub-hosted runners have full network access, so this works even when the Claude Code sandbox can't reach Google Maven.
- **Pinned ref at writing:** `89e5dbeabb7b3b97262aa87b8671c10c2e847139` (main, 2026-10-30).

### Matching state
Upstream tests build their own collections; Flashi must render identical data. Write extra Roborazzi tests (use `DeckPickerScreenshotTest.kt` / `ReviewerScreenshotTest.kt` as templates) that load **`fixtures/golden-fixture.json`** (decks, note types, notes, card states, "now"). The web harness loads the same JSON.

Canonical v1 screens: deck list (fixture) · deck list empty · FAB expanded · nav drawer · reviewer question · reviewer answer with labels · reviewer cloze Q/A · reviewer overflow menu · congrats. Reuse upstream frames where the state is reproducible (e.g. DeckPicker `baseState` / `fabExpanded` with 0 decks).

### Web harness — `npm run golden`
- Playwright Chromium. Derive density from the qualifier string (e.g. 420dpi → 2.625 — read it, don't guess); viewport = PNG pixels ÷ density, `deviceScaleFactor` = density.
- Load `dist/flashi.html?theme=golden&fixture=golden&screen=<id>`. Deterministic: `page.clock` fixed to the fixture's "now", animations off, wait for `document.fonts.ready`.
- Diff with pixelmatch (threshold ~0.1, anti-alias detection) and report SSIM too. Masks per screen in `golden/masks/<screen>.json` (rects in dp): system bars, brand title/logo, time-dependent text.
- Report at `golden/report/index.html`: golden | Flashi | diff overlay | mismatch %.
- CI budget per screen starts around 5% and tightens toward < 1%. Robolectric and Chrome rasterize text differently — use masks and tolerance, don't chase subpixel anti-aliasing.
- Loop: render → diff → fix CSS → repeat. Attach the report to each PR.

## 10. README (initial)

```markdown
# Flashi

Sorry, I'll think of a better name eventually.

A free, open-source flashcard app for your phone's browser, modeled on AnkiDroid.
Add it to your Home Screen and study offline. Imports Anki `.apkg` decks.

## Install on iPhone
1. Open the site in Safari.
2. Tap Share → **Add to Home Screen**.
3. Launch Flashi from the Home Screen. (Data saved in a regular Safari tab can be wiped after 7 days without a visit — the Home Screen app keeps it.)

## Status
Early prototype. Back up with **Export** regularly.

## License
AGPL-3.0-or-later. Includes code derived from AnkiDroid (GPL-3.0-or-later) and Anki (AGPL-3.0-or-later). See NOTICE.md.

Flashi is not affiliated with or endorsed by Ankitects Pty Ltd or the AnkiDroid project.
```

## 11. Decisions for Aiden

| Decision | Default if nobody answers |
|---|---|
| UI library | Preact |
| Final green palette | M3 palette from seed `#8BC34A` |
| Test iPhone viewport | 393 × 852 (iPhone 15/16) |
| Max `.apkg` import size | 500 MB, warn above 100 MB |
| Internal collection schema | Schema 11 SQLite |
| Real name | Flashi |

[webkit-storage]: https://webkit.org/?p=14403
[sel-7day]: https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519
[mdn-quota]: https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
