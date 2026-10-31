# Visual comparison

`npm run golden` builds the development-only golden theme and records ten
canonical screens using `fixtures/golden-fixture.json` and its fixed UTC time.
Open `golden/report/index.html` for Android / Flashi / diff views, mismatch
percentages and SSIM. `results.json` is machine-readable.

Reference PNGs belong in `golden/android/<screen>.png`, with `<screen>.json`
containing the density recorded from Android's actual display metrics. Viewports
are calculated from PNG pixel dimensions divided by that density; when there is
no reference, previews use the 393×852 phone target at 2× and are marked pending.
Missing Android references never count as a parity pass. Use
`npm run golden -- --require-baselines` to fail on missing references too.

Run the **Record Android golden frames** workflow to compile and record the
pinned AnkiDroid commit in `ANKIDROID_REF`. It copies the extra Roborazzi tests
and the same JSON fixture into the checkout, uploads captures, and opens a PR
with the canonical reference files. GitHub must allow Actions to create PRs.
No Android emulator is required. The JVM workflow needs JDK 21 and network
access for Gradle/Android/Robolectric dependencies.

The native test covers nine screens. The Flashi congratulations page has no
matching native reviewer screen (AnkiDroid returns to its study options); its
reference is intentionally pending until an equivalent StudyOptions capture is
selected. Robolectric does not render WebView card HTML, so native card bounds
are masked when comparing reviewer chrome. Web card content is still visible
in the report and covered by template tests. Masks in `masks/` use CSS px / dp;
keep their reason explicit and do not hide unexplained layout differences.

The initial mismatch budget is 5% of unmasked pixels per screen; pixelmatch uses
0.1 color threshold and ignores antialias-only differences. Tighten budgets only
after reference comparisons are reviewed. The golden theme, fixture loader, and
fixture data are compiled out of the artifact and PWA release builds.
