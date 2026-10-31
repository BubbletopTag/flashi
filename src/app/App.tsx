// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "preact/hooks";
import type { ImportProgress } from "../anki/apkg/import";
import { About, Settings } from "../screens/Settings";
import { Congrats } from "../screens/Congrats";
import { DeckPicker } from "../screens/DeckPicker";
import { Reviewer } from "../screens/Reviewer";
import { PwaNotices } from "../platform/pwa";
import { WARN_IMPORT_BYTES, type AppController } from "./controller";
import { Dialog, FlashiLogo, Icon, ripple, Snackbar, TextButton, Toolbar, type SnackbarMessage } from "./ui";

type Screen = { name: "decks" } | { name: "review"; deckId: number } | { name: "congrats"; deckId: number } | { name: "settings" } | { name: "about" };

type Modal =
  | { kind: "createDeck" }
  | { kind: "progress"; title: string; label: string; fraction: number | null }
  | { kind: "message"; title: string; text: string }
  | { kind: "confirmLarge"; file: File }
  | { kind: "deleteData" };

export function App({ app }: { app: AppController }) {
  const goldenScreen = __FLASHI_GOLDEN__ && new URLSearchParams(location.search).get("fixture") === "golden" ? new URLSearchParams(location.search).get("screen") : null;
  const initialScreen = (): Screen => {
    if (goldenScreen === "congrats") return { name: "congrats", deckId: app.col.deckByName("Finished")!.id };
    if (goldenScreen && ["question", "answer", "overflow", "cloze-question", "cloze-answer"].includes(goldenScreen)) {
      return { name: "review", deckId: app.col.deckByName(goldenScreen.startsWith("cloze") ? "Languages::Cloze" : "Languages::French")!.id };
    }
    return { name: "decks" };
  };
  const [, setVersion] = useState(0);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [drawer, setDrawer] = useState(goldenScreen === "drawer");
  const [fabOpen, setFabOpen] = useState(goldenScreen === "fab");
  const [modal, setModal] = useState<Modal | null>(null);
  const [snack, setSnack] = useState<SnackbarMessage | null>(null);
  const [deckName, setDeckName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => app.subscribe(() => setVersion(app.version)), []);

  const showMessage = (text: string, action?: SnackbarMessage["action"]) => setSnack({ text, action, key: Date.now() });

  const runImport = async (file: File) => {
    setModal({ kind: "progress", title: "Importing", label: "Reading package…", fraction: null });
    try {
      const result = await app.importFile(file, (p: ImportProgress) => {
        const label = p.phase === "media" ? "Copying media" : p.phase === "notes" ? "Adding notes" : p.phase === "cards" ? "Adding cards" : "Reading package…";
        setModal({ kind: "progress", title: "Importing", label: p.total > 1 ? `${label} (${p.done + 1} of ${p.total})` : label, fraction: p.total > 1 ? p.done / p.total : null });
      });
      setModal(null);
      setScreen({ name: "decks" });
      showMessage(`Imported ${result.notesAdded} ${result.notesAdded === 1 ? "note" : "notes"}${result.notesUpdated ? `, updated ${result.notesUpdated}` : ""}${result.mediaAdded ? `, ${result.mediaAdded} media files` : ""}.`);
    } catch (e) {
      setModal({ kind: "message", title: "Import failed", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > WARN_IMPORT_BYTES) setModal({ kind: "confirmLarge", file });
    else void runImport(file);
  };

  const exportBackup = async () => {
    setModal({ kind: "progress", title: "Exporting", label: "Preparing backup…", fraction: null });
    try {
      const r = await app.exportBackup((label) => setModal({ kind: "progress", title: "Exporting", label, fraction: null }));
      setModal(null);
      if (r.outcome === "saved") showMessage(`Saved ${r.filename}`);
      else if (r.outcome === "declined") showMessage("Export cancelled");
      else setModal({ kind: "message", title: "Export failed", text: "This browser didn't allow the file to be saved." });
    } catch (e) {
      setModal({ kind: "message", title: "Export failed", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const openImport = () => {
    setFabOpen(false);
    setDrawer(false);
    fileInput.current?.click();
  };

  const days = app.daysSinceBackup();
  const needsBackup = app.col.cardCount() > 0 && (days === null ? num(app.col.db.scalar("select count() from revlog")) > 0 : days >= 7);

  const fab = (
    <>
      {fabOpen ? <div class="fab-scrim" onClick={() => setFabOpen(false)} /> : null}
      <div class="fab-area">
        {fabOpen ? (
          <>
            <button type="button" class="fab-action ripple" id="fab-import" onPointerDown={ripple} onClick={openImport}>
              <Icon name="download" /> Import
            </button>
            <button
              type="button"
              class="fab-action ripple"
              id="fab-create-deck"
              onPointerDown={ripple}
              onClick={() => {
                setFabOpen(false);
                setDeckName("");
                setModal({ kind: "createDeck" });
              }}
            >
              <Icon name="addDeck" /> Create deck
            </button>
          </>
        ) : null}
        <button type="button" class={`fab ripple${fabOpen ? " open" : ""}`} id="fab" aria-label="Add" aria-expanded={fabOpen} onPointerDown={ripple} onClick={() => setFabOpen(!fabOpen)}>
          <Icon name="add" />
        </button>
      </div>
    </>
  );

  let body;
  switch (screen.name) {
    case "decks":
      body = (
        <div class="screen">
          <Toolbar title="Flashi" nav={{ icon: "menu", label: "Open menu", onClick: () => setDrawer(true) }} />
          {app.storageError || app.saveError ? (
            <div class="banner warn" role="alert">
              <p>{app.saveError ? "Your latest changes couldn't be saved." : "Storage is unavailable here, so progress won't survive a reload."} Export a backup to keep your progress.</p>
              <TextButton label="Export" onClick={() => void exportBackup()} />
            </div>
          ) : needsBackup ? (
            <div class="banner">
              <p>{days === null ? "You haven't backed up yet." : `Last backup ${days} days ago.`} Browsers can clear saved data.</p>
              <TextButton label="Export" onClick={() => void exportBackup()} />
            </div>
          ) : null}
          <DeckPicker app={app} fab={fab} onStudy={(deckId) => setScreen({ name: "review", deckId })} />
        </div>
      );
      break;
    case "review":
      body = (
        <Reviewer
          app={app}
          deckId={screen.deckId}
          onBack={() => setScreen({ name: "decks" })}
          onFinished={() => setScreen({ name: "congrats", deckId: screen.deckId })}
          showMessage={(text, action) => showMessage(text, action ? { label: action.label, onClick: () => { action.onClick(); setScreen({ name: "review", deckId: screen.deckId }); } } : undefined)}
        />
      );
      break;
    case "congrats":
      body = (
        <Congrats
          app={app}
          deckId={screen.deckId}
          onBack={() => setScreen({ name: "decks" })}
          onStudyAgain={() => setScreen({ name: "review", deckId: screen.deckId })}
        />
      );
      break;
    case "settings":
      body = <Settings app={app} onMenu={() => setDrawer(true)} onExport={() => void exportBackup()} onImport={openImport} onAbout={() => setScreen({ name: "about" })} onDelete={() => setModal({ kind: "deleteData" })} />;
      break;
    case "about":
      body = <About onBack={() => setScreen({ name: "settings" })} />;
      break;
  }

  const go = (s: Screen) => {
    setDrawer(false);
    setScreen(s);
  };

  return (
    <div class={`app-shell${snack ? " has-snackbar" : ""}`}>
      {body}
      {__FLASHI_TARGET__ === "pwa" ? <PwaNotices app={app} /> : null}
      {drawer ? (
        <>
          <div class="scrim" onClick={() => setDrawer(false)} />
          <aside class="drawer" aria-label="Navigation">
            <div class="drawer-header">
              <FlashiLogo />
              <div>
                <div class="brand">Flashi</div>
                <div class="tagline">Flashcards in your browser</div>
              </div>
            </div>
            <nav>
              <button type="button" class={`drawer-item ripple${screen.name === "decks" ? " active" : ""}`} onPointerDown={ripple} onClick={() => go({ name: "decks" })}>
                <Icon name="list" /> Decks
              </button>
              <button type="button" class="drawer-item ripple" onPointerDown={ripple} onClick={openImport}>
                <Icon name="download" /> Import
              </button>
              <button type="button" class="drawer-item ripple" onPointerDown={ripple} onClick={() => { setDrawer(false); void exportBackup(); }}>
                <Icon name="backup" /> Export backup
              </button>
              <button type="button" class={`drawer-item ripple${screen.name === "settings" ? " active" : ""}`} onPointerDown={ripple} onClick={() => go({ name: "settings" })}>
                <Icon name="settings" /> Settings
              </button>
              <button type="button" class={`drawer-item ripple${screen.name === "about" ? " active" : ""}`} onPointerDown={ripple} onClick={() => go({ name: "about" })}>
                <Icon name="infoOutline" /> About
              </button>
            </nav>
          </aside>
        </>
      ) : null}
      <input
        ref={fileInput}
        id="import-file"
        type="file"
        accept=".apkg,.colpkg,.zip"
        class="visually-hidden"
        tabIndex={-1}
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          pickFile(input.files?.[0]);
          input.value = "";
        }}
      />
      {modal?.kind === "createDeck" ? (
        <Dialog title="Create deck" onDismiss={() => setModal(null)}>
          <input
            type="text"
            id="deck-name"
            aria-label="Deck name"
            placeholder="Deck name"
            value={deckName}
            ref={(el) => el?.focus()}
            onInput={(e) => setDeckName((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && deckName.trim()) {
                app.createDeck(deckName);
                setModal(null);
              }
            }}
          />
          <div class="hint">Use :: to make a subdeck, e.g. Languages::Spanish.</div>
          <div class="actions">
            <TextButton label="Cancel" onClick={() => setModal(null)} />
            <TextButton
              label="Create"
              id="create-deck-ok"
              disabled={!deckName.trim()}
              onClick={() => {
                app.createDeck(deckName);
                setModal(null);
              }}
            />
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === "progress" ? (
        <Dialog title={modal.title}>
          <p>{modal.label}</p>
          <div class="progress-track">
            <div class={`progress-bar${modal.fraction === null ? " indeterminate" : ""}`} style={{ width: `${Math.round((modal.fraction ?? 0) * 100)}%` }} />
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === "message" ? (
        <Dialog title={modal.title} onDismiss={() => setModal(null)}>
          <p>{modal.text}</p>
          <div class="actions">
            <TextButton label="OK" onClick={() => setModal(null)} />
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === "confirmLarge" ? (
        <Dialog title="Large file" onDismiss={() => setModal(null)}>
          <p>This file is {Math.round(modal.file.size / 1024 / 1024)} MB. Importing it can take a while and use a lot of this browser's storage.</p>
          <div class="actions">
            <TextButton label="Cancel" onClick={() => setModal(null)} />
            <TextButton label="Import" onClick={() => void runImport(modal.file)} />
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === "deleteData" ? (
        <Dialog title="Delete all data?" onDismiss={() => setModal(null)}>
          <p>This permanently removes all decks, media, progress, and automatic backups from this device. Export a backup first if you want to keep them.</p>
          <div class="actions">
            <TextButton label="Cancel" onClick={() => setModal(null)} />
            <TextButton label="Delete everything" onClick={() => {
              setModal({ kind: "progress", title: "Deleting data", label: "Removing this device's collection…", fraction: null });
              void app.deleteAllData().catch((e: unknown) => setModal({ kind: "message", title: "Delete failed", text: e instanceof Error ? e.message : String(e) }));
            }} />
          </div>
        </Dialog>
      ) : null}
      <Snackbar message={snack} onDone={() => setSnack(null)} />
    </div>
  );
}

function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
}
