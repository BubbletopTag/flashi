#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Import an .apkg into a fresh collection with the official `anki` package
(the backend Anki desktop uses) and print what landed, as JSON.

Used by tests/apkg.test.ts to prove Flashi's exports import into Anki with
scheduling intact. Usage: check-export.py PACKAGE.apkg
"""

import json
import os
import sys
import tempfile

from anki.collection import Collection, ImportAnkiPackageOptions, ImportAnkiPackageRequest


def main() -> None:
    path = sys.argv[1]
    d = tempfile.mkdtemp()
    col = Collection(os.path.join(d, "collection.anki2"))
    req = ImportAnkiPackageRequest(
        package_path=path,
        options=ImportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True),
    )
    col.import_anki_package(req)
    cards = col.db.all(
        "select n.guid, c.ord, c.type, c.queue, "
        "case when c.queue in (2, 3) or c.type = 2 then c.due - ? else c.due end, "
        "c.ivl, c.factor, c.reps, c.lapses, c.left, c.flags "
        "from cards c join notes n on n.id = c.nid order by n.guid, c.ord",
        col.sched.today,
    )
    decks = sorted(d.name for d in col.decks.all_names_and_ids())
    media = sorted(os.listdir(col.media.dir()))
    print(
        json.dumps(
            {
                "cards": cards,
                "revlog": col.db.scalar("select count(*) from revlog"),
                "notes": col.note_count(),
                "decks": decks,
                "media": media,
            }
        )
    )


if __name__ == "__main__":
    main()
