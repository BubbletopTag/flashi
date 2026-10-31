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
sync, FSRS scheduling, filtered/custom study, image occlusion editing, and add-ons.
Keep exports from your original Anki collection when trying unfamiliar decks.
