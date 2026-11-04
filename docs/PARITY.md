# Local functionality plan

The owner confirmed iPhone blur and package import are working, and requested
continued development toward AnkiDroid's local functionality, including statistics.
AnkiWeb sync is explicitly excluded. Work directly on main, verify changes, and
publish working increments without waiting for overnight confirmation.

## Core local workflows

- [x] Import/export legacy and current Anki packages with scheduling and media.
- [x] SM-2 reviewer, queue/limits, cloze, type-answer, audio and MathJax.
- [x] Offline PWA, journal, backups, iPhone Home Screen and file-picker fixes.
- [x] Original favicon in both release targets.
- [ ] Statistics: history, daily totals, calendar/streaks, answer distribution,
  intervals, card maturity, forecast, retention and deck/time filters.
- [x] Card browser: search, tags, note types, states, sorting, preview and bulk actions.
- [x] Add/edit notes, fields/tags, cloze, reverse templates, media and duplicate warnings.
- [x] Card information/review history, editing during review, marking.
- [x] Deck/preset options, daily limits, deck rename/delete/move.
- [x] FSRS-4.5/5/6 scheduling, imported memory states, retention and parameters.
- [ ] FSRS parameter optimization/evaluation and bulk rescheduling.
- [ ] Custom study/filtered decks with preview and rescheduling modes.
- [ ] Note-type fields/templates/CSS management and card generation.
- [ ] Image occlusion creation/editing/review.
- [x] Dark/system appearance for the app and imported-card night modes.
- [ ] Gestures, tap zones, TTS and whiteboard.
- [ ] CSV/TSV import/export, media checking and collection maintenance.
- [ ] Shortcuts, undo for management actions, accessible mobile layouts and help.
- [ ] Final full regression/export-to-Anki/browser/offline checks and documentation.

## Separate validation

Exact Android screenshot parity is measured, but eight canonical screens currently
exceed the initial diff budget. Reference recording works and outputs a review
branch. Do not describe those screens as passing until their diffs are resolved.
Actual claude.ai artifact publication still requires a connected artifact tool.
Native iPhone file-picker behavior cannot be simulated fully by desktop Chromium.

Statistics layout now follows upstream Anki graphs (also used by AnkiDroid).
FSRS memory-state graphs are implemented. Full native graph interactions remain.
104 unit tests total; the new FSRS scenarios compare all four answers against
official Anki, with exact intervals and memory-state tolerance 0.001.
13 mobile browser scenarios pass, including FSRS export and persistence.
