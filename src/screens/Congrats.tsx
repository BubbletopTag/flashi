// SPDX-License-Identifier: AGPL-3.0-or-later
// Shown when a deck has nothing left to study (Anki's congrats page).

import type { AppController } from "../app/controller";
import { TextButton, Toolbar } from "../app/ui";

export function learningWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function Congrats(props: { app: AppController; deckId: number; onBack: () => void; onStudyAgain: () => void }) {
  const { app } = props;
  const info = app.col.congratsInfo(props.deckId);
  const deck = app.col.deck(props.deckId);
  return (
    <div class="screen">
      <Toolbar title={deck?.name.split("::").pop() ?? "Deck"} nav={{ icon: "back", label: "Back to decks", onClick: props.onBack }} />
      <div class="content-page">
        <div class="congrats">
          <svg viewBox="0 0 88 88" aria-hidden="true">
            <circle cx="44" cy="44" r="40" fill="var(--topbar)" />
            <path d="M27 45l11 11 23-25" fill="none" stroke="var(--primary)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <h2>Congratulations! You have finished this deck for now.</h2>
          {info.learnRemaining > 0 ? (
            <p>The next learning card will be ready in {learningWait(info.secsUntilNextLearn)}.</p>
          ) : null}
          {info.reviewRemaining ? (
            <p>Today's review limit has been reached, but there are still cards waiting to be reviewed. For optimum memory, consider increasing the daily limit in the deck's options.</p>
          ) : null}
          {info.newRemaining ? (
            <p>There are more new cards available, but the daily limit has been reached. The more new cards you introduce, the higher your short-term review workload becomes.</p>
          ) : null}
          {info.haveBuried ? <p>Some related or buried cards were delayed until a later session.</p> : null}
          <div class="actions">
            {info.haveBuried ? (
              <TextButton
                label="Unbury cards"
                onClick={() => {
                  app.col.unburyDeck(props.deckId);
                  app.changed();
                  props.onStudyAgain();
                }}
              />
            ) : null}
            {info.learnRemaining > 0 ? <TextButton label="Check again" onClick={props.onStudyAgain} /> : null}
            <TextButton label="Back to decks" id="congrats-back" onClick={props.onBack} />
          </div>
        </div>
      </div>
    </div>
  );
}
