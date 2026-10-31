#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Record Anki's own scheduling decisions so Flashi's port can be tested against them.

Uses the official `anki` package (pip install anki). Run it with a non-UTC
TZ (the CI default is TZ=America/Los_Angeles) so day-rollover math is exercised. Writes
fixtures/logic-goldens.json, consumed by tests/scheduler.goldens.test.ts.

Each scenario records the card row and deck config that went in, the
scheduling states and button labels Anki computed (fuzz enabled, exactly as
in a real collection), and, for answer scenarios, the card and revlog rows
Anki wrote afterwards. Timing inputs (crt, offsets, rollover, "now") are
recorded so the TypeScript side can reproduce the same day numbers.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time

from anki.collection import Collection
from anki.scheduler.v3 import CardAnswer
from google.protobuf.json_format import MessageToDict

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures", "logic-goldens.json")
CARD_COLS = "id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data"
REVLOG_COLS = "id,cid,usn,ease,ivl,lastIvl,factor,time,type"


def card_row(col: Collection, cid: int) -> dict:
    vals = col.db.first(f"select {CARD_COLS} from cards where id=?", cid)
    return dict(zip(CARD_COLS.split(","), vals))


def revlog_rows(col: Collection, cid: int) -> list[dict]:
    rows = col.db.all(f"select {REVLOG_COLS} from revlog where cid=? order by id", cid)
    return [dict(zip(REVLOG_COLS.split(","), r)) for r in rows]


def timing(col: Collection) -> dict:
    return {
        "crt": col.crt,
        "creationOffset": col.get_config("creationOffset", None),
        "localOffset": col.get_config("localOffset", None),
        "rollover": col.get_config("rollover", 4),
        "today": col.sched.today,
        "dayCutoff": col.sched.day_cutoff,
        # minutes west of UTC right now, as Anki computes the current offset
        "currentMinutesWest": -time.localtime().tm_gmtoff // 60,
    }


def states_dict(states) -> dict:
    return MessageToDict(states, preserving_proto_field_name=True, always_print_fields_with_no_presence=True)


def clean_label(s: str) -> str:
    return s.replace("⁨", "").replace("⁩", "")


class Builder:
    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.col = Collection(os.path.join(self.dir, "collection.anki2"))
        self.basic = self.col.models.by_name("Basic")

    def add_card(self, deck: str = "Default", text: str = "x") -> int:
        did = self.col.decks.id(deck)
        note = self.col.new_note(self.basic)
        note["Front"] = text
        note["Back"] = text
        self.col.add_note(note, did)
        return note.cards()[0].id

    def set_card(self, cid: int, **fields) -> None:
        sets = ", ".join(f"{k}=?" for k in fields)
        self.col.db.execute(f"update cards set {sets} where id=?", *fields.values(), cid)

    def deck_config(self, deck: str = "Default") -> dict:
        did = self.col.decks.id(deck)
        return self.col.decks.config_dict_for_deck_id(did)


def snapshot(b: Builder, cid: int, label: str, deck: str = "Default", build_queues: bool = False) -> dict:
    col = b.col
    if build_queues:
        col.sched.get_queued_cards()
    before = card_row(col, cid)
    now = time.time()
    states = col._backend.get_scheduling_states(cid)
    labels = [clean_label(s) for s in col.sched.describe_next_states(states)]
    return {
        "name": label,
        "now": now,
        "timing": timing(col),
        "config": b.deck_config(deck),
        "card": before,
        "states": states_dict(states),
        "labels": labels,
    }


def answer(b: Builder, cid: int, rating: int) -> dict:
    col = b.col
    card = col.get_card(cid)
    card.start_timer()
    states = col._backend.get_scheduling_states(cid)
    # CardAnswer.Rating is 0-based (AGAIN=0); revlog ease is 1-based.
    ans = col.sched.build_answer(card=card, states=states, rating=rating - 1)
    col.sched.answer_card(ans)
    return {"card": card_row(col, cid), "revlog": revlog_rows(col, cid)[-1]}


def main() -> None:
    scenarios: list[dict] = []
    answers: list[dict] = []

    # --- default preset, no queues built (no load balancer) -------------
    b = Builder()
    today = b.col.sched.today

    new_ids = [b.add_card(text=f"new {i}") for i in range(12)]
    for cid in new_ids[:4]:
        scenarios.append(snapshot(b, cid, f"new card {cid}"))

    for i, cid in enumerate(new_ids[4:8]):
        b.set_card(cid, type=1, queue=1, due=int(time.time()) - 30, left=2 - (i % 2), reps=1 + i)
        scenarios.append(snapshot(b, cid, f"learning left={2 - (i % 2)}"))

    review_cases = [
        (1, 2500, 0, 0), (3, 2500, 0, 0), (10, 2500, 0, 0), (30, 2350, 1, 0), (100, 1300, 4, 0),
        (8, 2500, 0, 5), (20, 2650, 0, 12), (6, 2500, 0, -3), (25, 2500, 0, -10), (365, 2500, 2, 40),
        (1, 1300, 7, 0), (15, 2500, 0, 1),
    ]
    for ivl, factor, lapses, late in review_cases:
        cid = b.add_card(text=f"rev {ivl} {late}")
        b.set_card(cid, type=2, queue=2, ivl=ivl, factor=factor, lapses=lapses, due=today - late, reps=5 + lapses)
        scenarios.append(snapshot(b, cid, f"review ivl={ivl} factor={factor} late={late}"))

    for left in (1,):
        cid = b.add_card(text="relearn")
        b.set_card(cid, type=3, queue=1, ivl=10, factor=2300, lapses=2, left=left, due=int(time.time()) - 5, reps=12)
        scenarios.append(snapshot(b, cid, f"relearning left={left}"))

    # Answer flows with every button from a range of states.
    for rating in (1, 2, 3, 4):
        cid = b.add_card(text=f"answer new {rating}")
        before = card_row(b.col, cid)
        snap = snapshot(b, cid, f"answer new rating={rating}")
        answers.append({**snap, "rating": rating, "before": before, **{"after": answer(b, cid, rating)}})
    for rating in (1, 2, 3, 4):
        cid = b.add_card(text=f"answer review {rating}")
        b.set_card(cid, type=2, queue=2, ivl=12, factor=2500, lapses=0, due=today - 2, reps=6)
        before = card_row(b.col, cid)
        snap = snapshot(b, cid, f"answer review rating={rating}")
        answers.append({**snap, "rating": rating, "before": before, "after": answer(b, cid, rating)})
    # A leech: 7 lapses, failed again → 8th lapse.
    cid = b.add_card(text="leech")
    b.set_card(cid, type=2, queue=2, ivl=3, factor=1300, lapses=7, due=today, reps=20)
    before = card_row(b.col, cid)
    snap = snapshot(b, cid, "answer leech again")
    answers.append({**snap, "rating": 1, "before": before, "after": answer(b, cid, 1)})
    # Full learning progression: new → good → good (graduates) and relearning → good.
    cid = b.add_card(text="progression")
    for step in range(3):
        before = card_row(b.col, cid)
        snap = snapshot(b, cid, f"progression step {step}")
        answers.append({**snap, "rating": 3, "before": before, "after": answer(b, cid, 3)})
        # Pretend the learning delay has passed.
        b.col.db.execute("update cards set due=? where id=? and queue=1", int(time.time()) - 1, cid)
    cid = b.add_card(text="relearn answer")
    b.set_card(cid, type=3, queue=1, ivl=4, factor=2100, lapses=1, left=1, due=int(time.time()) - 5, reps=9)
    for rating in (3,):
        before = card_row(b.col, cid)
        snap = snapshot(b, cid, "answer relearning good")
        answers.append({**snap, "rating": rating, "before": before, "after": answer(b, cid, rating)})

    # --- custom preset ----------------------------------------------------
    b2 = Builder()
    today2 = b2.col.sched.today
    conf = b2.col.decks.add_config_returning_id("Custom")
    c = b2.col.decks.get_config(conf)
    c["new"]["delays"] = [1, 10, 1440]
    c["new"]["ints"] = [2, 5, 0]
    c["new"]["initialFactor"] = 2300
    c["lapse"]["delays"] = [10, 1440]
    c["lapse"]["mult"] = 0.5
    c["lapse"]["minInt"] = 2
    c["rev"]["hardFactor"] = 1.0
    c["rev"]["ivlFct"] = 0.8
    c["rev"]["maxIvl"] = 100
    c["rev"]["ease4"] = 1.5
    b2.col.decks.update_config(c)
    deck = b2.col.decks.get(b2.col.decks.id("Custom deck"))
    deck["conf"] = conf
    b2.col.decks.save(deck)
    for i in range(3):
        cid = b2.add_card("Custom deck", f"custom new {i}")
        scenarios.append(snapshot(b2, cid, f"custom new {i}", "Custom deck"))
    for left in (3, 2, 1):
        cid = b2.add_card("Custom deck", f"custom learn {left}")
        b2.set_card(cid, type=1, queue=1, left=left, due=int(time.time()) - 10, reps=3)
        scenarios.append(snapshot(b2, cid, f"custom learning left={left}", "Custom deck"))
    for ivl, late in ((5, 0), (40, 3), (90, 0), (99, 20), (3, -1)):
        cid = b2.add_card("Custom deck", f"custom rev {ivl}")
        b2.set_card(cid, type=2, queue=2, ivl=ivl, factor=2300, due=today2 - late, reps=7)
        scenarios.append(snapshot(b2, cid, f"custom review ivl={ivl} late={late}", "Custom deck"))
    for left in (2, 1):
        cid = b2.add_card("Custom deck", f"custom relearn {left}")
        b2.set_card(cid, type=3, queue=1, ivl=20, factor=2000, lapses=3, left=left, due=int(time.time()) - 5, reps=15)
        scenarios.append(snapshot(b2, cid, f"custom relearning left={left}", "Custom deck"))

    # --- load balancer (queues built) --------------------------------------
    b3 = Builder()
    today3 = b3.col.sched.today
    lb_cards = []
    for day in range(1, 40):
        for k in range((day * 7) % 5):
            cid = b3.add_card("LB", f"lb filler {day} {k}")
            b3.set_card(cid, type=2, queue=2, ivl=day, factor=2500, due=today3 + day, reps=4)
    for i, (ivl, late) in enumerate(((4, 0), (7, 1), (12, 0), (20, 2), (35, 0), (60, 4), (80, 0), (120, 0))):
        cid = b3.add_card("LB", f"lb target {i}")
        b3.set_card(cid, type=2, queue=2, ivl=ivl, factor=2500, due=today3 - late, reps=6 + i)
        lb_cards.append(cid)
    b3.col.sched.get_queued_cards()
    all_rows = [
        dict(zip(("id", "nid", "did", "due", "queue"), r))
        for r in b3.col.db.all("select id, nid, did, due, queue from cards")
    ]
    decks = {str(d["id"]): {"conf": d.get("conf"), "dyn": d.get("dyn")} for d in b3.col.decks.all()}
    lb_scenarios = [snapshot(b3, cid, f"load balanced review {cid}", "LB") for cid in lb_cards]

    out = {
        "generator": "scripts/make-logic-goldens.py",
        "anki": __import__("anki.buildinfo", fromlist=["version"]).version,
        "scenarios": scenarios,
        "answers": answers,
        "loadBalancer": {"cards": all_rows, "decks": decks, "scenarios": lb_scenarios},
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"wrote {OUT}: {len(scenarios)} scenarios, {len(answers)} answers, {len(lb_scenarios)} load-balanced")


if __name__ == "__main__":
    sys.exit(main())
