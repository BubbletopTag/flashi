# Third-party notices

Flashi is licensed under AGPL-3.0-or-later; see LICENSE. Flashi is not affiliated
with or endorsed by Ankitects Pty Ltd or the AnkiDroid project. The Flashi name,
light-green card-and-lightning mark, and app icons are original to this project.

The following upstream projects supply code, algorithms, assets, or build tools.
Copyright remains with the respective authors. SPDX headers in individual source
files identify ports; the upstream repositories contain the complete notices.
Versions resolved for JavaScript dependencies are recorded in package-lock.json.

| Source | Use | License / attribution |
| --- | --- | --- |
| [Anki](https://github.com/ankitects/anki) | v3 SM-2 scheduler, queue/limits, collection schema, template/cloze/filter behavior, protobuf package formats; logic and package fixture generation | AGPL-3.0-or-later; Ankitects Pty Ltd and contributors |
| [AnkiDroid](https://github.com/ankidroid/Anki-Android), ref `89e5dbeabb7b3b97262aa87b8671c10c2e847139` | Layouts/dimensions, light-theme test tokens, vector icons, `flashcard.css` card wrapper, SoundUtils.kt audio markup, TypeAnswer.kt prompt, libanki ETA calculation | GPL-3.0-or-later; AnkiDroid contributors; Material icons retain their Apache-2.0 attribution |
| [rand / rand_core](https://github.com/rust-random/rand) | PCG32 seed expansion, random-range and WeightedIndex algorithms | MIT OR Apache-2.0; The Rust Project Developers and rust-random contributors |
| [chacha20](https://github.com/RustCrypto/stream-ciphers) | ChaCha12 algorithm used by rand 0.10.1 | MIT OR Apache-2.0; RustCrypto Developers |
| [Python difflib](https://github.com/python/cpython/blob/main/Lib/difflib.py) | SequenceMatcher algorithm used in type-answer comparison | Python-2.0; Python Software Foundation; algorithm by Tim Peters |
| [SQLite](https://sqlite.org/) | Database engine | Public domain; SQLite authors |
| [SQLite WASM wrapper](https://github.com/sqlite/sqlite-wasm) | Official SQLite WebAssembly distribution and JavaScript integration | Apache-2.0; SQLite authors and wrapper contributors |
| [Preact](https://github.com/preactjs/preact) | UI and hooks | MIT; Jason Miller and contributors |
| [fflate](https://github.com/101arrowz/fflate) | ZIP and deflate | MIT; Arjun Barrett |
| [fzstd](https://github.com/101arrowz/fzstd) | Zstandard decompression | MIT; Arjun Barrett |
| [MathJax](https://github.com/mathjax/MathJax) | Card mathematics rendering | Apache-2.0; The MathJax Consortium |
| [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) | Build-time green tonal palette | Apache-2.0; Google LLC |
| [Roboto / Fontsource](https://github.com/fontsource/fontsource) | Bundled Roboto font files for UI, including offline use | OFL-1.1 (bundled font); Roboto Project Authors; see public/fonts/LICENSE-Roboto.txt. Fontsource packaging: MIT |
| [Vite](https://github.com/vitejs/vite), [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) | Build system and HTML bundling | MIT; respective project contributors |
| [TypeScript](https://github.com/microsoft/TypeScript) | Type checking | Apache-2.0; Microsoft Corporation |
| [tsx](https://github.com/privatenumber/tsx), [esbuild](https://github.com/evanw/esbuild) | Development scripts / transpilation | MIT; respective project contributors |
| [Vitest](https://github.com/vitest-dev/vitest) | Unit tests | MIT; Vitest contributors |
| [Playwright](https://github.com/microsoft/playwright) | Browser tests and screenshots | Apache-2.0; Microsoft Corporation |
| [pixelmatch](https://github.com/mapbox/pixelmatch), [pngjs](https://github.com/pngjs/pngjs) | Golden-frame PNG comparison | ISC (pixelmatch), MIT (pngjs); respective project contributors |
| [ssim.js](https://github.com/obartra/ssim) | Structural similarity reports | MIT; Oscar Bartra and contributors |
| [genanki](https://github.com/kerrickstaley/genanki) | Legacy Anki fixture generation | MIT; Kerrick Staley and contributors |
| [Roborazzi](https://github.com/takahirom/roborazzi), [Robolectric](https://github.com/robolectric/robolectric) | Upstream Android screenshot generation | Apache-2.0, MIT respectively; project contributors |

Development-only dependencies and their transitive notices are also distributed
in their npm/Python package metadata and LICENSE files. The original AGPL/GPL
upstream notices remain applicable to ports, even when implementation syntax differs.
