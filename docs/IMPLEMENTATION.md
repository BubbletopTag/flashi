# Completion notes — 2026-10-31

The local phone-test server runs with `npm run dev -- --host 0.0.0.0 --port 5173`.
For the current machine, the Tailscale address is http://100.96.199.11:5173/.
A normal HTTP IP address can use IndexedDB but cannot install a service worker or
use OPFS. Test installation/offline mode over HTTPS or on localhost.

## Implemented

- Phase 0 documentation/notices, pinned Android ref, CI, Pages deployment and
  Android reference-recording workflows.
- Browser tests for both release builds: 20 answers, immediate reload/journal
  replay, export/reimport, storage denial, startup WASM failure, deletion with
  confirmation, offline use, undo persistence, multi-tab protection and migration.
- Startup errors terminate cleanly; unreadable collections are preserved rather
  than overwritten. Overlapping saves are serialized.
- Undo after bury/suspend returns to the focused card; rebuilding the queue no
  longer double-counts that card. Answer undo persists the snapshot and journal
  before displaying success.
- Delete-data confirmation, autoplay preference, readable learning wait times,
  snackbar clearance, mobile viewport sizing, and corrected deck-row indentation.
- LAN/HTTP-compatible SHA-1 media checksums when Web Crypto isn't available.
- PWA manifest, original light-green icons, Apple installation metadata,
  self-hosted Roboto, scope-relative precaching, explicit update prompt with a
  save before activation, persistent-storage request and Safari installation hint.
- SQLite `opfs-sahpool` Worker persistence and OPFS media, migrating the existing
  IndexedDB collection/media only after all copies succeed. Pending-answer
  journals and preferences remain in IndexedDB. A committed OPFS migration
  never silently falls back to the old, stale IndexedDB collection.
- The UI's synchronous scheduler still operates on an in-memory schema-11
  collection; the Worker atomically commits its serialized snapshots inside an
  OPFS SQLite database. This avoids rewriting the scheduler/UI as async RPCs.
- Five recent automatic collection snapshots, deduplicated, downloadable from
  Settings as Anki packages using the device's retained media. These are local
  recovery points; manual exports remain the portable backup.
- Deterministic JSON fixture and ten web screen previews, pixelmatch/SSIM report,
  explicit masks, 5% initial budgets and strict missing-baseline option.

## Local tools update

- System/light/dark appearance, including imported-card night-mode classes.
- Original inline SVG favicon in artifact and PWA builds.
- Anki-style statistics panel layout and chart order: Today, Future Due, Calendar,
  Reviews, Card Counts, Review Intervals, Card Ease, True Retention, Hourly
  Breakdown, Answer Buttons, Added. Includes deck/history/range filters.
- Card browser with quoted/boolean search, deck/tag/field/state/numeric filters,
  sorting, preview, card information/history and undoable bulk management.
- Local note add/edit with imported note types, cloze/reverse card generation,
  media attachments, tags, duplicate warnings, preview and scheduling retention.
- Deck options and shared presets, limits, step units, display order, sibling
  burying, audio/timer settings, rename/move/delete and undo. Long-press a deck
  to open its options, or use the navigation drawer.
- New notes and edits export successfully into official Anki.
- Full AnkiDroid feature parity is still in progress; see PARITY.md.

## Verification

- `npm run typecheck` passes.
- All 102 unit tests pass with `FLASHI_ANKI_PYTHON=.venv/bin/python`, including
  live official-Anki queue/export comparisons.
- All twelve Chromium browser scenarios pass against both release builds.
- `npm run golden` generates all ten previews; missing Android references are
  reported as pending rather than parity passes.
- CI and Pages deployment pass on GitHub. The published site was opened in
  Chromium, its service worker installed, and it reloaded successfully offline
  with no page errors: https://bubbletoptag.github.io/flashi/.

## iPhone follow-ups

- The user confirmed the Home Screen top blur cleared after adding a real solid
  viewport-fixed status strip, removing root scrolling, and including the Apple
  app metadata in the shared HTML used by the local server as well as releases.
- Import no longer filters the native picker by unknown `.apkg` extensions.
  The selected file stays attached to its input during asynchronous archive
  reads; it is reset only before the next picker opens. A regression scenario
  models a file provider revoking access when that selection is cleared.
- Empty/unreadable files now have actionable local-download errors. Confirmation
  with the user's actual iPhone deck was confirmed successful.

## External validation still required

- No Claude artifact publishing tool is connected here. The built
  `dist/flashi.html` can be published from claude.ai to the existing private URL.
  Actual claude.ai CSP, file picker, downloads capability and persistence remain
  unverified; browser tests cover the corresponding standalone HTML behavior.
- A user-provided real AnkiWeb deck with images/audio and physical iPhone Safari
  testing are still needed. Generated fixtures cover legacy/current exports,
  images, audio, and scheduling against official Anki 26.9.3.
- Android reference generation has passed in GitHub Actions (run 41170381209).
  The reference branch is `golden/refresh-android`; the repository blocks Actions
  from opening PRs, so the workflow provides a manual compare link. Exact visual
  parity is still incomplete: the local report currently passes decks and
  congratulations, with eight other screens over the initial 5% budget. Extra tests
  cover ten native screens, using the empty-deck StudyOptions screen for the
  native congratulations state. See golden/README.md.
- GitHub Pages has been enabled for Actions at https://bubbletoptag.github.io/flashi/.
  Deployment is verified separately from local builds.

The original scope exclusions remain: AnkiWeb sync, FSRS, custom/filtered study,
image occlusion editing, card browser/editor and the other Phase 4 features.
