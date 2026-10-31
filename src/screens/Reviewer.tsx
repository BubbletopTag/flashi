// SPDX-License-Identifier: AGPL-3.0-or-later
// Reviewer clone (AnkiDroid's legacy Reviewer, the default at the pinned ref):
// activity_reviewer.xml, include_reviewer_topbar.xml, include_reviewer_answer_buttons.xml.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { QueuedCard } from "../anki/collection";
import { cardFlag } from "../anki/model";
import { answerWithTyped, renderCardContent, type CardContent } from "../anki/template/render";
import { AudioPlayer } from "../app/audio";
import { buildCardDocument } from "../app/cardFrame";
import type { AppController } from "../app/controller";
import { Icon, IconButton, PopupMenu, ripple, Toolbar, type MenuItem } from "../app/ui";

export const FLAGS = [
  { value: 1, name: "Red", color: "var(--flag-red)" },
  { value: 2, name: "Orange", color: "var(--flag-orange)" },
  { value: 3, name: "Green", color: "var(--flag-green)" },
  { value: 4, name: "Blue", color: "var(--flag-blue)" },
  { value: 5, name: "Pink", color: "var(--flag-pink)" },
  { value: 6, name: "Turquoise", color: "var(--flag-turquoise)" },
  { value: 7, name: "Purple", color: "var(--flag-purple)" },
];

function remainingTime(minutes: number): string {
  if (minutes < 60) {
    const m = Math.max(minutes, 1);
    return `${m} ${m === 1 ? "minute" : "minutes"} left`;
  }
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    return `${h} ${h === 1 ? "hour" : "hours"} ${minutes % 60} left`;
  }
  const d = Math.floor(minutes / 1440);
  return `${d} ${d === 1 ? "day" : "days"} ${Math.round((minutes % 1440) / 60)} left`;
}

function formatTimer(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function Reviewer(props: {
  app: AppController;
  deckId: number;
  onBack: () => void;
  onFinished: () => void;
  showMessage: (text: string, action?: { label: string; onClick: () => void }) => void;
}) {
  const { app, deckId } = props;
  const col = app.col;
  const prefs = app.prefs();
  const audio = useMemo(() => new AudioPlayer(app.store.media), []);
  const [queued, setQueued] = useState<QueuedCard | null>(null);
  const [content, setContent] = useState<CardContent | null>(null);
  const [side, setSide] = useState<"q" | "a">("q");
  const [doc, setDoc] = useState<string>("");
  const [typed, setTyped] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[]; label: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const shownAt = useRef(Date.now());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const busy = useRef(false);
  const deck = col.deck(deckId);
  const config = useMemo(() => col.configForDeck(deckId), [deckId, app.version]);

  const loadNext = () => {
    const next = col.nextCard(deckId);
    if (!next) {
      audio.stop();
      props.onFinished();
      return;
    }
    const c = renderCardContent(col, next.card);
    setQueued(next);
    setContent(c);
    setSide("q");
    setTyped("");
    shownAt.current = Date.now();
    setNow(Date.now());
  };

  useEffect(() => {
    col.selectDeck(deckId);
    loadNext();
    return () => audio.stop();
  }, [deckId]);

  // Build the frame document whenever the card or side changes.
  useEffect(() => {
    if (!content || !queued) return;
    let cancelled = false;
    const body = side === "q" ? content.question : answerWithTyped(content, typed);
    void buildCardDocument({ body, css: content.css, ord: content.ord, side, media: app.store.media }).then((html) => {
      if (cancelled) return;
      setDoc(html);
      if (config.autoplay) void audio.play(side === "q" ? content.questionAv : content.answerAv);
    });
    return () => {
      cancelled = true;
    };
  }, [content, side]);

  // Messages from the sandboxed card frame.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as { flashi?: number; type?: string; side?: string; index?: number; href?: string };
      if (!m || m.flashi !== 1 || !content) return;
      if (m.type === "play") {
        const tags = m.side === "a" ? content.answerAv : content.questionAv;
        const tag = tags[m.index ?? -1];
        if (tag) void audio.play([tag]);
      } else if (m.type === "open" && m.href && /^https?:/i.test(m.href)) {
        const a = document.createElement("a");
        a.href = m.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [content]);

  // Card timer (shown only when the deck preset turns it on, like AnkiDroid).
  useEffect(() => {
    if (!config.showTimer) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [config.showTimer]);

  const showAnswer = () => {
    if (side === "a" || !content) return;
    setSide("a");
  };

  const answer = async (rating: number) => {
    if (!queued || side !== "a" || busy.current) return;
    busy.current = true;
    try {
      audio.stop();
      const taken = Date.now() - shownAt.current;
      await app.answer(queued.card.id, rating, taken);
      loadNext();
    } catch (e) {
      props.showMessage(`Couldn't save that answer: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy.current = false;
    }
  };

  // Keyboard: space/enter shows the answer, then 1–4 answer (Anki desktop's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu || (e.target instanceof HTMLInputElement && e.key !== "Enter")) return;
      if (side === "q" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        showAnswer();
      } else if (side === "a" && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        void answer(Number(e.key));
      } else if (side === "a" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        void answer(3);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const undo = () => {
    const label = col.undo();
    if (!label) return;
    app.changed();
    loadNext();
    props.showMessage(`${label} undone`);
  };

  const cardOps = (op: "buryCard" | "buryNote" | "suspendCard" | "suspendNote", message: string) => {
    if (!queued) return;
    audio.stop();
    col[op](queued.card.id);
    app.changed();
    loadNext();
    props.showMessage(message, { label: "Undo", onClick: undo });
  };

  const setFlag = (value: number) => {
    if (!queued) return;
    col.setFlag(queued.card.id, value);
    const card = col.getCard(queued.card.id);
    if (card) setQueued({ ...queued, card });
    app.changed();
  };

  if (!queued || !content) {
    return (
      <div class="screen">
        <Toolbar nav={{ icon: "back", label: "Back to decks", onClick: props.onBack }} />
        <div class="loading">Loading…</div>
      </div>
    );
  }

  const counts = queued.counts;
  const kind = queued.kind === "interdayLearning" ? "learning" : queued.kind;
  const flag = cardFlag(queued.card);
  const flagInfo = FLAGS.find((f) => f.value === flag);
  const eta = prefs.showEta ? remainingTime(app.etaMinutes(counts)) : undefined;
  const labels = queued.labels;

  return (
    <div class="screen reviewer">
      <Toolbar
        nav={{ icon: "back", label: "Back to decks", onClick: props.onBack }}
        title={prefs.showDeckTitle ? (deck?.name.split("::").pop() ?? "") : undefined}
        subtitle={eta}
      >
        <IconButton icon="undo" label="Undo" disabled={!col.canUndo()} onClick={undo} />
        <IconButton
          icon={flagInfo ? "flag" : "flagOutline"}
          color={flagInfo?.color}
          label="Flag card"
          onClick={(e) =>
            setMenu({
              anchor: e.currentTarget as HTMLElement,
              label: "Flag card",
              items: [
                { label: "No flag", icon: "flag", iconColor: "#D3D3D3", onSelect: () => setFlag(0) },
                ...FLAGS.map((f) => ({ label: `${f.name} flag`, icon: "flag" as const, iconColor: f.color, onSelect: () => setFlag(f.value) })),
              ],
            })
          }
        />
        <IconButton
          icon="moreVert"
          label="More options"
          onClick={(e) =>
            setMenu({
              anchor: e.currentTarget as HTMLElement,
              label: "More options",
              items: [
                { label: "Bury card", icon: "bury", onSelect: () => cardOps("buryCard", "Card buried") },
                { label: "Bury note", icon: "bury", onSelect: () => cardOps("buryNote", "Note buried") },
                { label: "Suspend card", icon: "suspend", onSelect: () => cardOps("suspendCard", "Card suspended") },
                { label: "Suspend note", icon: "suspend", onSelect: () => cardOps("suspendNote", "Note suspended") },
              ],
            })
          }
        />
      </Toolbar>
      <div class="topbar" aria-label="Cards left">
        <span class={`count count-new${kind === "new" ? " current" : ""}`} aria-label={`${counts.new} new`}>{counts.new}</span>
        <span class={`count count-learn${kind === "learning" ? " current" : ""}`} aria-label={`${counts.learning} learning`}>{counts.learning}</span>
        <span class={`count count-review${kind === "review" ? " current" : ""}`} aria-label={`${counts.review} to review`}>{counts.review}</span>
        {flagInfo ? (
          <span class="flag-slot">
            <Icon name="flag" color={flagInfo.color} title={`${flagInfo.name} flag`} />
          </span>
        ) : null}
        {config.showTimer ? <span class="timer">{formatTimer(Math.min(now - shownAt.current, config.capAnswerTimeToSecs * 1000))}</span> : null}
      </div>
      <div class="card-area">
        <iframe
          ref={frameRef}
          title={side === "q" ? "Card question" : "Card answer"}
          sandbox="allow-scripts"
          srcdoc={doc}
          referrerpolicy="no-referrer"
        />
      </div>
      {content.typeAnswer && side === "q" ? (
        <input
          class="answer-field"
          id="answer-field"
          type="text"
          placeholder="Type answer"
          aria-label="Type answer"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={typed}
          onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              showAnswer();
            }
          }}
        />
      ) : null}
      <div class="bottom-area">
        {side === "q" ? (
          <button type="button" class="flip-btn ripple" id="show-answer" onPointerDown={ripple} onClick={showAnswer}>
            Show answer
          </button>
        ) : (
          <div class="ease-buttons" role="group" aria-label="Answer">
            {(["again", "hard", "good", "easy"] as const).map((name, i) => (
              <button
                type="button"
                class={`ease-btn ${name} ripple`}
                id={`ease-${i + 1}`}
                onPointerDown={ripple}
                onClick={() => void answer(i + 1)}
                aria-label={`${name[0]!.toUpperCase()}${name.slice(1)}, ${labels[i]}`}
              >
                <span class="next">{labels[i]}</span>
                <span class="label">{["Again", "Hard", "Good", "Easy"][i]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {menu ? <PopupMenu anchor={menu.anchor} items={menu.items} label={menu.label} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
