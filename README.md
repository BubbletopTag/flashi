# Flashi

Sorry, I'll think of a better name eventually.

A free, open-source flashcard app for your phone's browser, modeled on AnkiDroid.
Add it to your Home Screen and study offline. Imports Anki `.apkg` decks.

Also here: **Flashlet**, a Quizlet-style study app (Flashcards, Learn, Test, Match, Meteor), at
[`/flashlet/`](https://bubbletoptag.github.io/flashi/flashlet/). It is a single self-contained page,
`public/flashlet/index.html`, and saves decks and progress in the browser.

And **Sub Bar**, Spanish listening and ordering practice for a sub counter, at
[`/sub-bar/`](https://bubbletoptag.github.io/flashi/sub-bar/). It installs to the Home Screen and works offline.
*Server* mode: a customer says one of 50 orders in Spanish, you type what they want in English before the
clock runs out. *Customer* mode: you read 50 different English subs and order each one in Spanish. The menu and
orders live in `scripts/sub-bar/build.py`, which also makes the Edge TTS audio and `public/sub-bar/data.js`.

## Install on iPhone
1. Open the site in Safari.
2. Tap Share → **Add to Home Screen**.
3. Launch Flashi from the Home Screen. (Data saved in a regular Safari tab can be wiped after 7 days without a visit — the Home Screen app keeps it.)

## Status
Early prototype. Back up with **Export** regularly.

## License
AGPL-3.0-or-later. Includes code derived from AnkiDroid (GPL-3.0-or-later) and Anki (AGPL-3.0-or-later). See NOTICE.md.

Flashi is not affiliated with or endorsed by Ankitects Pty Ltd or the AnkiDroid project.

## Development

Use Node.js 22.12+ and Python 3.11+.

```sh
npm ci
npm run dev -- --host 0.0.0.0
npm run check
npm run build
npx playwright install chromium
npm run e2e
```

The artifact build is `dist/flashi.html` (self-contained). The installable web app
is `dist-pwa/`; serve it over HTTPS, or on localhost for testing. For phone testing
on a LAN or Tailscale, `npm run dev -- --host 0.0.0.0 --port 5173` exposes the app.
HTTP IP addresses do not support service workers or OPFS; use HTTPS to test installation.

To include the live official-Anki compatibility checks:

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
FLASHI_ANKI_PYTHON=.venv/bin/python npm test
```

See [the build brief](docs/SPEC.md), [handoff](docs/HANDOFF.md), and
[visual test instructions](golden/README.md). Unsupported features include AnkiWeb
sync, filtered/custom study, image occlusion editing, and add-ons.

Recent local features include statistics, system/light/dark appearance, a card
browser, note editing and media attachments, deck presets, and FSRS-4.5/5/6.
See [the parity checklist](docs/PARITY.md) for the remaining local work.
Keep exports from your original Anki collection when trying unfamiliar decks.
