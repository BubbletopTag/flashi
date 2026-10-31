#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Import a package into a fresh official-Anki collection and print the deck
list counts and the study queue order for one deck, as JSON.

Used by tests/queue.test.ts. Usage: queue-golden.py PACKAGE.apkg "Deck name" [ANSWERS]
ANSWERS is an optional string of ratings 1-4 to answer from the queue first.
"""

import json
import os
import sys
import tempfile

from anki.collection import Collection, ImportAnkiPackageOptions, ImportAnkiPackageRequest


def walk(node, prefix, out):
    for child in node.children:
        name = f"{prefix}::{child.name}" if prefix else child.name
        out[name] = [child.new_count, child.learn_count, child.review_count]
        walk(child, name, out)


def main() -> None:
    path, deck_name = sys.argv[1], sys.argv[2]
    answers = sys.argv[3] if len(sys.argv) > 3 else ""
    d = tempfile.mkdtemp()
    col = Collection(os.path.join(d, "collection.anki2"))
    col.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=path,
            options=ImportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True),
        )
    )
    did = col.decks.id_for_name(deck_name)
    col.decks.select(did)
    for ch in answers:
        queued = col.sched.get_queued_cards()
        qc = queued.cards[0]
        card = col.get_card(qc.card.id)
        card.start_timer()
        col.sched.answer_card(col.sched.build_answer(card=card, states=qc.states, rating=int(ch) - 1))
    counts = {}
    walk(col.sched.deck_due_tree(), "", counts)
    queued = col.sched.get_queued_cards(fetch_limit=1000)
    order = []
    for qc in queued.cards:
        note = col.get_note(qc.card.note_id)
        order.append([note.guid, qc.card.template_idx])
    print(
        json.dumps(
            {
                "counts": counts,
                "queue": order,
                "queueCounts": [queued.new_count, queued.learning_count, queued.review_count],
            }
        )
    )


if __name__ == "__main__":
    main()
