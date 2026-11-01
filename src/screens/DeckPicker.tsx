// SPDX-License-Identifier: AGPL-3.0-or-later
// DeckPicker clone: include_deck_picker.xml + item_deck.xml + DeckAdapter.kt.

import { useMemo, useState } from "preact/hooks";
import type { DeckTreeNode } from "../anki/scheduler/deckTree";
import { num } from "../anki/sqlite";
import type { AppController } from "../app/controller";
import { Icon, ripple } from "../app/ui";

interface Row {
  node: DeckTreeNode;
  depth: number;
}

function flatten(tree: DeckTreeNode, out: Row[] = [], depth = 0): Row[] {
  for (const child of tree.children) {
    out.push({ node: child, depth });
    if (!child.collapsed) flatten(child, out, depth + 1);
  }
  return out;
}

function CardStackArt() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect x="26" y="14" width="44" height="58" rx="6" fill="var(--surface-variant)" transform="rotate(-8 48 43)" />
      <rect x="26" y="18" width="44" height="58" rx="6" fill="var(--topbar)" stroke="var(--primary)" stroke-width="2" />
      <path d="M38 40h20M38 48h20M38 56h12" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}

export function DeckPicker(props: {
  app: AppController;
  onStudy: (deckId: number) => void;
  fab: preact.ComponentChildren;
  onOptions?: (deckId: number) => void;
}) {
  const { app } = props;
  const [, force] = useState(0);
  const col = app.col;
  const tree = useMemo(() => col.deckTree(), [app.version]);
  const rows = flatten(tree);
  const hasSubdecks = tree.children.some((c) => c.children.length > 0) || rows.some((r) => r.depth > 0);
  const current = col.currentDeckId();
  const empty = col.cardCount() === 0;
  const studied = useMemo(() => {
    const timing = col.timing();
    const r = col.db.first("select count(), coalesce(sum(time), 0) from revlog where id > ?", [(timing.nextDayAt - 86_400) * 1000]);
    return { cards: num(r?.[0]), minutes: Math.round(num(r?.[1]) / 60000) };
  }, [app.version]);

  const toggle = (node: DeckTreeNode) => {
    col.setDeckCollapsed(node.deckId, !node.collapsed);
    app.changed();
    force((n) => n + 1);
  };

  if (empty && rows.length <= 1 && (rows[0]?.node.totalIncludingChildren ?? 0) === 0) {
    return (
      <div class="screen">
        <div class="empty-state">
          <CardStackArt />
          <h2>Collection is empty</h2>
          <p>{"Import a deck or create one\nusing the + button."}</p>
        </div>
        {props.fab}
      </div>
    );
  }

  return (
    <div class="screen">
      <ul class={`deck-list${hasSubdecks ? " has-subdecks" : ""}`} aria-label="Decks">
        {rows.map(({ node, depth }, i) => (
          <>
            {i > 0 && depth === 0 ? <li class="deck-divider" role="presentation" /> : null}
            <li
              class={`deck-row ripple${node.deckId === current ? " current" : ""}`}
              onPointerDown={ripple}
              onClick={() => props.onStudy(node.deckId)}
              onContextMenu={(event) => {event.preventDefault();props.onOptions?.(node.deckId);}}
              data-deck-id={node.deckId}
            >
              {hasSubdecks ? (
                <>
                  <span class="indent" style={{ width: `${16 * depth}px` }} />
                  <button
                    type="button"
                    class={`expander${node.children.length ? "" : " hidden"}${depth ? " nested" : ""}`}
                    aria-label={node.collapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
                    aria-expanded={node.children.length ? !node.collapsed : undefined}
                    tabIndex={node.children.length ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (node.children.length) toggle(node);
                    }}
                  >
                    <Icon name={node.collapsed ? "chevronRight" : "expandMore"} />
                  </button>
                </>
              ) : null}
              <div class={`name${node.filtered ? " filtered" : ""}`}>
                <span>{node.name}</span>
              </div>
              <div class="counts" aria-label={`${node.newCount} new, ${node.learnCount} learning, ${node.reviewCount} due`}>
                <span class={node.newCount ? "count-new" : "count-zero"}>{node.newCount}</span>
                <span class={node.learnCount ? "count-learn" : "count-zero"}>{node.learnCount}</span>
                <span class={node.reviewCount ? "count-review" : "count-zero"}>{node.reviewCount}</span>
              </div>
            </li>
          </>
        ))}
      </ul>
      <div class="studied-today">
        {studied.cards
          ? `Studied ${studied.cards} ${studied.cards === 1 ? "card" : "cards"} in ${studied.minutes} ${studied.minutes === 1 ? "minute" : "minutes"} today.`
          : ""}
      </div>
      {props.fab}
    </div>
  );
}
