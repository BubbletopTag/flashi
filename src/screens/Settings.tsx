// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "preact/hooks";
import type { AppController } from "../app/controller";
import { ripple, Switch, Toolbar } from "../app/ui";
import { storageEstimate } from "../storage/store";
import notices from "virtual:third-party-notices";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Settings(props: { app: AppController; onMenu: () => void; onExport: () => void; onImport: () => void; onAbout: () => void; onDelete: () => void }) {
  const { app } = props;
  const prefs = app.prefs();
  const [usage, setUsage] = useState<string>("Calculating…");
  const [backups, setBackups] = useState<number[]>([]);
  const [storageStatus, setStorageStatus] = useState("");
  const [backupStatus, setBackupStatus] = useState("");
  useEffect(() => {
    void (async () => {
      const media = await app.store.media.totalBytes().catch(() => 0);
      const est = await storageEstimate();
      setUsage(`${bytes(app.col.serialize().length + media)} for this collection${est ? ` · ${bytes(est.usage)} of ${bytes(est.quota)} allowed` : ""}`);
      setBackups(await app.store.listBackups?.().catch(() => []) ?? []);
      const persisted = await navigator.storage?.persisted?.().catch(() => false);
      setStorageStatus(persisted ? "Persistent storage is enabled." : "Ask this browser to keep Flashi’s data.");
    })();
  }, [app.version]);
  const days = app.daysSinceBackup();
  const backup = days === null ? "Never backed up" : days === 0 ? "Last backup today" : `Last backup ${days} ${days === 1 ? "day" : "days"} ago`;
  const toggle = (key: "showDeckTitle" | "showEta" | "autoplay", label: string, summary: string) => (
    <button type="button" class="pref ripple" role="switch" aria-checked={prefs[key]} onPointerDown={ripple} onClick={() => void app.setPref(key, !prefs[key])}>
      <div class="body">
        <div class="label">{label}</div>
        <div class="summary">{summary}</div>
      </div>
      <Switch on={prefs[key]} />
    </button>
  );
  return (
    <div class="screen">
      <Toolbar title="Settings" nav={{ icon: "menu", label: "Open menu", onClick: props.onMenu }} />
      <div class="content-page">
        <section class="pref-group">
          <h3>Your data</h3>
          <div class="pref">
            <div class="body">
              <div class="label">Storage used</div>
              <div class="summary">{usage}</div>
            </div>
          </div>
          {navigator.storage?.persist ? <button type="button" class="pref ripple" onPointerDown={ripple} onClick={() => {
            void navigator.storage.persist().then((allowed) => setStorageStatus(allowed ? "Persistent storage is enabled." : "This browser hasn't granted persistent storage. Keep exporting backups.")).catch(() => setStorageStatus("Persistent storage isn't available here. Keep exporting backups."));
          }}><div class="body"><div class="label">Keep data on this device</div><div class="summary">{storageStatus}</div></div></button> : null}
          <button type="button" class="pref ripple" onPointerDown={ripple} onClick={props.onExport}>
            <div class="body">
              <div class="label">Export backup</div>
              <div class="summary">{backup}. Saves your decks and progress as a package Anki can import.</div>
            </div>
          </button>
          <button type="button" class="pref ripple" onPointerDown={ripple} onClick={props.onImport}>
            <div class="body">
              <div class="label">Import deck</div>
              <div class="summary">Add an Anki .apkg deck or a Flashi backup.</div>
            </div>
          </button>
          <button type="button" class="pref ripple danger" onPointerDown={ripple} onClick={props.onDelete}>
            <div class="body"><div class="label">Delete all data</div><div class="summary">Remove every deck, media file, and saved answer from this device.</div></div>
          </button>
        </section>
        {backups.length ? <section class="pref-group">
          <h3>Automatic backups</h3>
          <p>The latest five collection snapshots. Downloads include the media still on this device.</p>
          {backups.map((id) => <button type="button" class="pref ripple" onPointerDown={ripple} onClick={() => {
            setBackupStatus("Preparing backup…");
            void app.exportAutomaticBackup(id).then(() => setBackupStatus("Backup downloaded.")).catch((e: unknown) => setBackupStatus(e instanceof Error ? e.message : String(e)));
          }}><div class="body"><div class="label">{new Date(id).toLocaleString()}</div><div class="summary">Download this backup</div></div></button>)}
          {backupStatus ? <p role="status">{backupStatus}</p> : null}
        </section> : null}
        <section class="pref-group">
          <h3>Reviewing</h3>
          {toggle("showDeckTitle", "Show deck title", "Show the deck name in the reviewer's toolbar.")}
          {toggle("showEta", "Show time left", "Estimate the minutes needed to finish today's cards.")}
          {toggle("autoplay", "Autoplay audio", "Play card audio automatically when the deck allows it.")}
        </section>
        <section class="pref-group">
          <h3>About</h3>
          <button type="button" class="pref ripple" onPointerDown={ripple} onClick={props.onAbout}>
            <div class="body">
              <div class="label">About Flashi</div>
              <div class="summary">Version {__FLASHI_VERSION__} · licenses · source code</div>
            </div>
          </button>
        </section>
      </div>
    </div>
  );
}

export function About(props: { onBack: () => void }) {
  return (
    <div class="screen">
      <Toolbar title="About" nav={{ icon: "back", label: "Back", onClick: props.onBack }} />
      <div class="content-page about">
        <div class="pref-group">
          <p>
            <strong>Flashi</strong> {__FLASHI_VERSION__}: a free, open-source flashcard app for your phone's browser, modeled on AnkiDroid.
          </p>
          <p>
            Source code: <a href="https://github.com/BubbletopTag/flashi" target="_blank" rel="noopener noreferrer">github.com/BubbletopTag/flashi</a>
          </p>
          <p>Licensed under the GNU Affero General Public License v3.0 or later. Includes code derived from AnkiDroid (GPL-3.0-or-later) and Anki (AGPL-3.0-or-later).</p>
          <p>Flashi is not affiliated with or endorsed by Ankitects Pty Ltd or the AnkiDroid project.</p>
          <h3>Third-party software</h3>
          <p><a href="https://github.com/BubbletopTag/flashi/blob/main/NOTICE.md" target="_blank" rel="noopener noreferrer">Full third-party notices and licenses</a></p>
          <ul>
            <li>Anki scheduler, template engine and package format (AGPL-3.0-or-later, Ankitects Pty Ltd and contributors)</li>
            <li>AnkiDroid layouts, icons and card wrapper (GPL-3.0-or-later, AnkiDroid contributors)</li>
            <li>SQLite WASM (public domain / Apache-2.0)</li>
            <li>Preact (MIT), fflate (MIT), fzstd (MIT), MathJax (Apache-2.0)</li>
            <li>rand / rand_core / chacha20 algorithms (MIT OR Apache-2.0)</li>
            <li>Material Design icons (Apache-2.0), Roboto (OFL-1.1)</li>
          </ul>
          <details><summary>Bundled notices and license texts</summary><pre class="license-text">{notices}</pre></details>
        </div>
      </div>
    </div>
  );
}
