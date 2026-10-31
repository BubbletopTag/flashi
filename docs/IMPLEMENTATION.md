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

## External validation still required

- No Claude artifact publishing tool is connected here. The built
  `dist/flashi.html` can be published from claude.ai to the existing private URL.
  Actual claude.ai CSP, file picker, downloads capability and persistence remain
  unverified; browser tests cover the corresponding standalone HTML behavior.
- A user-provided real AnkiWeb deck with images/audio and physical iPhone Safari
  testing are still needed. Generated fixtures cover legacy/current exports,
  images, audio, and scheduling against official Anki 26.9.3.
- Android baseline generation is a manual GitHub workflow. No Android references
  are checked in yet; preview generation is not a visual-parity pass. Extra tests
  cover nine native screens. The congratulations page needs a matched native
  StudyOptions reference before its comparison can be accepted. See golden/README.md.
- Pages deployment depends on enabling GitHub Pages with GitHub Actions in the
  repository settings. Local builds and CI do not themselves confirm deployment.

The original scope exclusions remain: AnkiWeb sync, FSRS, custom/filtered study,
image occlusion editing, card browser/editor and the other Phase 4 features.
