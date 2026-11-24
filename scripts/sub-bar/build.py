#!/usr/bin/env python3
"""Sub Bar: check the orders, make the audio, write data.js.

    pip install edge-tts          # plus ffmpeg on the PATH
    python scripts/sub-bar/build.py public/sub-bar

This file is the one place the menu and the 50 orders live. Each order has the
Spanish line the customer says and the English items it is graded on. Before any
audio is made, every line is checked against its items, so an order can never ask
for something the customer did not say.

Audio is only remade for orders whose text, voice or speed changed
(see audio/manifest.json).
"""
import asyncio
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import unicodedata

# ---------------------------------------------------------------- the menu
# id, kind, label shown to the player, English words that count as this item.
# `partial` words earn half credit (a wrap, without saying which wrap).
MENU = [
    ("white", "bread", "white bread", ["white bread", "white sub", "white roll", "white bun", "white"], []),
    ("wheat", "bread", "wheat bread", ["wheat bread", "whole wheat bread", "whole wheat", "wheat", "whole grain bread",
                                       "whole grain", "brown bread", "multigrain bread", "multigrain"], []),
    ("gf", "bread", "gluten-free bread", ["gluten free bread", "gluten free", "gluten", "gf bread", "gf"], []),
    ("flour", "bread", "flour tortilla", ["flour tortilla", "flour wrap", "plain tortilla", "plain wrap",
                                          "regular tortilla", "regular wrap", "white tortilla", "white wrap"],
     ["wrap", "tortilla"]),
    ("spinachT", "bread", "spinach tortilla", ["spinach tortilla", "spinach wrap", "green tortilla", "green wrap",
                                               "spinach flatbread"], ["wrap", "tortilla"]),
    ("tomatoT", "bread", "tomato tortilla", ["tomato tortilla", "tomato wrap", "red tortilla", "red wrap"],
     ["wrap", "tortilla"]),

    ("bacon", "filling", "bacon", ["bacon"], []),
    ("capicola", "filling", "capicola", ["capicola", "capicolla", "capocollo", "coppa"], []),
    ("ham", "filling", "ham", ["ham"], []),
    ("turkey", "filling", "turkey", ["turkey", "turkey breast"], []),
    ("salami", "filling", "salami", ["salami"], []),
    ("pepperoni", "filling", "pepperoni", ["pepperoni"], []),
    ("tuna", "filling", "tuna", ["tuna", "tuna salad"], []),
    ("chickensalad", "filling", "chicken salad", ["chicken salad", "chicken"], []),
    ("hummus", "filling", "hummus", ["hummus", "houmous", "humus"], []),

    ("american", "cheese", "American cheese", ["american cheese", "american"], []),
    ("provolone", "cheese", "provolone", ["provolone cheese", "provolone"], []),
    ("swiss", "cheese", "Swiss cheese", ["swiss cheese", "swiss"], []),
    ("cheddar", "cheese", "cheddar", ["cheddar cheese", "cheddar"], []),

    ("lettuce", "veg", "lettuce", ["lettuce"], []),
    ("spinach", "veg", "spinach", ["spinach", "spinach leaves", "baby spinach"], []),
    ("tomato", "veg", "tomatoes", ["tomato", "tomatoes"], []),
    ("jalapeno", "veg", "jalapeños", ["jalapeno", "jalapeno pepper", "jalapeno peppers"], []),
    ("bananapepper", "veg", "banana peppers", ["banana pepper", "banana peppers", "banana"], []),
    ("olive", "veg", "black olives", ["black olive", "black olives", "olive", "olives"], []),
    ("onion", "veg", "onions", ["onion", "onions", "red onion"], []),
    ("pickle", "veg", "dill pickles", ["dill pickle", "dill pickles", "pickle", "pickles", "dill"], []),

    ("mayo", "sauce", "mayo", ["mayonnaise", "mayo"], []),
    ("chipotle", "sauce", "chipotle mayo", ["chipotle mayonnaise", "chipotle mayo", "chipotle sauce", "chipotle",
                                            "mayo with chipotle", "chipotle and mayo", "spicy mayo"], []),
    ("mustard", "sauce", "mustard", ["mustard", "yellow mustard"], []),
    ("dressing", "sauce", "salad dressing", ["salad dressing", "dressing", "vinaigrette", "ranch"], []),

    ("toasted", "extra", "toasted", ["toasted", "toast", "toasty", "heated", "warmed"], []),
]

# What each item sounds like in the Spanish lines. Only used to check the orders.
ES = {
    "white": ["pan blanco"], "wheat": ["pan integral"], "gf": ["pan sin gluten"],
    "flour": ["tortilla de harina"], "spinachT": ["tortilla de espinaca"], "tomatoT": ["tortilla de tomate"],
    "bacon": ["tocino"], "capicola": ["capicola"], "ham": ["jamon"], "turkey": ["pavo"], "salami": ["salami"],
    "pepperoni": ["pepperoni"], "tuna": ["atun"], "chickensalad": ["ensalada de pollo"], "hummus": ["hummus"],
    "american": ["queso americano"], "provolone": ["provolone"], "swiss": ["queso suizo"], "cheddar": ["cheddar"],
    "lettuce": ["lechuga"], "spinach": ["espinaca"], "tomato": ["tomates", "tomate"], "jalapeno": ["jalapenos"],
    "bananapepper": ["pimientos banana"], "olive": ["aceitunas negras"], "onion": ["cebollas"],
    "pickle": ["pepinillos"],
    "chipotle": ["mayonesa chipotle"], "mayo": ["mayonesa"], "mustard": ["mostaza"], "dressing": ["aderezo"],
    "toasted": ["tostado", "tostada", "tostar"], "more": ["un poco mas"],
}


def O(bread, fill, cheese, veg, sauce, toasted, more, es):
    """One order. fill/cheese/veg/sauce are space-separated item ids; `more` is the id they want extra of."""
    return dict(bread=bread, fill=fill.split(), cheese=cheese.split(), veg=veg.split(), sauce=sauce.split(),
                toasted=toasted, more=more, es=es)


ORDERS = [
    # --- the usual: white, salami, pepperoni, provolone, toasted, chipotle mayo
    O("white", "salami pepperoni", "provolone", "", "chipotle", True, "",
      "Hola, quisiera un sub de pan blanco con salami, pepperoni y queso provolone. Tostado, con mayonesa chipotle, por favor."),
    O("white", "salami pepperoni", "provolone", "", "chipotle", True, "",
      "Buenas tardes. Me pones pan blanco con salami, pepperoni y queso provolone. Lo quiero tostado, con mayonesa chipotle."),
    O("white", "salami pepperoni", "provolone", "lettuce tomato", "chipotle", True, "",
      "Para mí, pan blanco con salami, pepperoni y queso provolone, con lechuga y tomates. ¿Me lo puede tostar? Y mayonesa chipotle, por favor."),
    O("white", "salami pepperoni", "provolone", "", "chipotle", True, "",
      "Hola, el de siempre: pan blanco, salami, pepperoni, queso provolone, tostado, y mayonesa chipotle."),
    O("white", "salami pepperoni", "provolone", "jalapeno", "chipotle", True, "jalapeno",
      "Buenas. Un sub de pan blanco con salami, pepperoni, queso provolone y jalapeños. Tostado, con mayonesa chipotle. Y un poco más de jalapeños, por favor."),
    O("white", "salami pepperoni", "provolone", "pickle", "chipotle", True, "",
      "Hola, quisiera pan blanco con salami y pepperoni, con queso provolone y pepinillos. Tostado, y mayonesa chipotle, por favor."),
    O("white", "salami pepperoni", "provolone", "lettuce onion", "chipotle", True, "",
      "Me das un sub de pan blanco con salami, pepperoni y queso provolone, con lechuga y cebollas. Tostado, con mayonesa chipotle."),

    # --- ordinary orders
    O("wheat", "turkey", "swiss", "lettuce tomato", "mustard", False, "",
      "Hola, para mí un sub de pan integral con pavo y queso suizo, con lechuga, tomates y mostaza, por favor."),
    O("white", "ham", "american", "lettuce", "mayo", True, "",
      "Buenos días. Quisiera pan blanco con jamón y queso americano, tostado, con lechuga y mayonesa."),
    O("white", "bacon turkey", "cheddar", "lettuce tomato", "mayo", True, "",
      "Me pones pan blanco con tocino, pavo y queso cheddar. Lo quiero tostado, con lechuga, tomates y mayonesa."),
    O("wheat", "tuna", "", "lettuce onion pickle", "mayo", False, "",
      "Un sub de pan integral con atún, lechuga, cebollas y pepinillos, con mayonesa, por favor."),
    O("flour", "chickensalad", "", "lettuce tomato", "", False, "",
      "Hola, quisiera una tortilla de harina con ensalada de pollo, lechuga y tomates, por favor."),
    O("wheat", "ham turkey", "swiss", "", "mustard", True, "",
      "Pan integral con jamón y pavo, queso suizo, tostado, con mostaza, por favor."),
    O("white", "turkey", "american", "lettuce tomato bananapepper", "dressing", False, "",
      "Para mí pan blanco con pavo y queso americano, con lechuga, tomates, pimientos banana y aderezo."),
    O("white", "capicola ham salami", "provolone", "olive bananapepper", "dressing", True, "",
      "Quisiera pan blanco con capicola, jamón y salami, con queso provolone. Tostado, con aceitunas negras, pimientos banana y aderezo, por favor."),
    O("flour", "pepperoni", "cheddar", "onion jalapeno", "", True, "",
      "Me das una tortilla de harina con pepperoni y queso cheddar, tostada, con cebollas y jalapeños."),
    O("white", "bacon", "american", "", "mayo", True, "",
      "Hola, pan blanco con tocino y queso americano. Tostado, con mayonesa, por favor."),
    O("spinachT", "", "", "lettuce spinach tomato onion pickle", "mustard", False, "",
      "Quisiera una tortilla de espinaca con lechuga, espinaca, tomates, cebollas y pepinillos, con mostaza, por favor."),
    O("tomatoT", "ham", "swiss", "lettuce", "mayo", False, "",
      "Para mí una tortilla de tomate con jamón y queso suizo, con lechuga y mayonesa."),
    O("white", "chickensalad", "cheddar", "pickle", "", True, "",
      "Quisiera pan blanco con ensalada de pollo y queso cheddar, tostado, con pepinillos, por favor."),
    O("wheat", "turkey bacon", "provolone", "lettuce tomato onion", "chipotle", True, "",
      "Me pones pan integral con pavo, tocino y queso provolone. Tostado, con lechuga, tomates, cebollas y mayonesa chipotle."),
    O("flour", "salami", "provolone", "lettuce tomato", "dressing", False, "",
      "Una tortilla de harina con salami y queso provolone, con lechuga, tomates y aderezo, por favor."),
    O("white", "ham", "american", "pickle", "mustard", False, "pickle",
      "Quisiera pan blanco con jamón y queso americano, con pepinillos y mostaza. Un poco más de pepinillos, por favor."),
    O("wheat", "tuna", "swiss", "onion tomato", "", True, "",
      "Para mí pan integral con atún y queso suizo, tostado, con cebollas y tomates."),
    O("wheat", "pepperoni", "cheddar", "bananapepper", "dressing", True, "",
      "Pan integral con pepperoni, queso cheddar y pimientos banana, tostado, con aderezo, por favor."),
    O("white", "bacon", "", "lettuce tomato", "mayo", True, "",
      "Quisiera pan blanco con tocino, lechuga y tomates, con mayonesa. Tostado, por favor."),
    O("flour", "turkey ham", "american", "lettuce tomato", "chipotle", False, "",
      "Me das una tortilla de harina con pavo, jamón y queso americano, con lechuga, tomates y mayonesa chipotle."),
    O("spinachT", "chickensalad", "", "spinach tomato", "", False, "",
      "Hola, quisiera una tortilla de espinaca con ensalada de pollo, con espinaca y tomates, por favor."),
    O("wheat", "salami pepperoni", "cheddar", "onion jalapeno olive", "", True, "",
      "Pan integral con salami y pepperoni, con queso cheddar. Tostado, con cebollas, jalapeños y aceitunas negras, por favor."),
    O("wheat", "hummus", "", "lettuce tomato pickle olive", "", False, "",
      "Para mí pan integral con hummus, lechuga, tomates, pepinillos y aceitunas negras, por favor."),

    # --- ridiculous orders
    O("spinachT", "hummus", "", "", "", True, "",
      "Hola, quisiera hummus en una tortilla de espinaca, tostada, por favor."),
    O("tomatoT", "hummus salami pepperoni", "american", "", "chipotle", False, "",
      "Me pones una tortilla de tomate con hummus, salami y pepperoni, con queso americano y mayonesa chipotle."),
    O("white", "tuna chickensalad", "", "pickle", "mustard", False, "",
      "Pan blanco con atún y ensalada de pollo, con pepinillos y mostaza, por favor."),
    O("spinachT", "bacon tuna", "cheddar", "", "dressing", True, "",
      "Quisiera una tortilla de espinaca con tocino y atún, con queso cheddar y aderezo, tostada."),
    O("white", "hummus ham", "", "bananapepper", "chipotle", True, "",
      "Para mí pan blanco con hummus y jamón, con pimientos banana y mayonesa chipotle. Lo quiero tostado."),
    O("wheat", "chickensalad pepperoni", "provolone", "jalapeno", "chipotle", True, "",
      "Me das pan integral con ensalada de pollo y pepperoni, con queso provolone, jalapeños y mayonesa chipotle. Tostado, por favor."),
    O("flour", "tuna hummus", "", "lettuce olive", "", False, "",
      "Una tortilla de harina con atún y hummus, con lechuga y aceitunas negras, por favor."),
    O("white", "", "", "lettuce spinach tomato jalapeno bananapepper olive onion pickle", "mustard", False, "",
      "Quisiera pan blanco con lechuga, espinaca, tomates, jalapeños, pimientos banana, aceitunas negras, cebollas y pepinillos. Con mostaza, por favor."),
    O("tomatoT", "capicola chickensalad hummus", "swiss", "", "", False, "",
      "Me pones una tortilla de tomate con capicola, ensalada de pollo y hummus, con queso suizo, por favor."),
    O("white", "bacon capicola ham turkey salami pepperoni", "american provolone", "", "chipotle mustard", True, "",
      "Quisiera pan blanco con tocino, capicola, jamón, pavo, salami y pepperoni, con queso americano y queso provolone. Tostado, con mayonesa chipotle y mostaza."),

    # --- gluten-free: these customers have no patience at all
    O("gf", "turkey", "swiss", "lettuce tomato", "", False, "",
      "Hola, quisiera pan sin gluten con pavo y queso suizo, con lechuga y tomates, por favor."),
    O("gf", "ham", "american", "", "mustard", True, "",
      "Para mí pan sin gluten con jamón y queso americano, tostado, con mostaza."),
    O("gf", "chickensalad", "", "lettuce pickle", "mayo", False, "",
      "Pan sin gluten con ensalada de pollo, lechuga y pepinillos, con mayonesa, por favor."),
    O("gf", "salami pepperoni", "provolone", "", "chipotle", True, "",
      "Buenas tardes. Quisiera pan sin gluten con salami, pepperoni y queso provolone. Tostado, con mayonesa chipotle."),
    O("gf", "tuna", "", "tomato onion", "dressing", False, "",
      "Para mí pan sin gluten con atún, tomates y cebollas, con aderezo, por favor."),
    O("gf", "hummus", "", "lettuce tomato olive", "", False, "",
      "Me das pan sin gluten con hummus, lechuga, tomates y aceitunas negras, por favor."),

    # --- asking for a little more
    O("wheat", "turkey", "cheddar", "jalapeno", "", True, "jalapeno",
      "Pan integral con pavo y queso cheddar, con jalapeños. ¿Me lo puede tostar? Y un poco más de jalapeños, por favor."),
    O("white", "ham", "swiss", "lettuce tomato", "dressing", False, "dressing",
      "Hola, pan blanco con jamón y queso suizo, con lechuga, tomates y aderezo. Un poco más de aderezo, por favor."),
    O("flour", "turkey bacon", "provolone", "", "chipotle", True, "chipotle",
      "Quisiera una tortilla de harina con pavo y tocino, con queso provolone, tostada, y un poco más de mayonesa chipotle, por favor."),
    O("white", "salami pepperoni", "provolone", "pickle", "chipotle", True, "pickle",
      "Pan blanco con salami y pepperoni, con queso provolone, pepinillos y mayonesa chipotle. Tostado, y un poco más de pepinillos, por favor."),
]

VOICES = ["es-MX-DaliaNeural", "es-MX-JorgeNeural", "es-US-AlonsoNeural", "es-US-PalomaNeural"]
RATES = ["-5%", "+0%", "+0%", "+5%", "+5%", "+10%", "+15%"]


# ---------------------------------------------------------------- checks
def words(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", s)


def spoken_items(es):
    """Items heard in a Spanish line: longest phrase first, each word used once."""
    toks = words(es)
    used = [False] * len(toks)
    pats = sorted(((i, words(p)) for i, ps in ES.items() for p in ps), key=lambda x: -len(x[1]))
    found = set()
    for item, p in pats:
        n = len(p)
        for k in range(len(toks) - n + 1):
            if toks[k:k + n] == p and not any(used[k:k + n]):
                used[k:k + n] = [True] * n
                found.add(item)
    return found


def wanted(o):
    ids = [o["bread"]] + o["fill"] + o["cheese"] + o["veg"] + o["sauce"]
    if o["toasted"]:
        ids.append("toasted")
    if o["more"]:
        assert o["more"] in o["veg"] + o["sauce"], f"more={o['more']} is not on the order: {o['es']}"
        ids.append("more:" + o["more"])
    return ids


def check_orders():
    known = {m[0] for m in MENU}
    bad = 0
    for n, o in enumerate(ORDERS, 1):
        ids = wanted(o)
        for i in ids:
            if not i.startswith("more:") and i not in known:
                print(f"order {n}: unknown item {i}")
                bad += 1
        want = {i if not i.startswith("more:") else "more" for i in ids}
        heard = spoken_items(o["es"])
        if want != heard:
            print(f"order {n}: says {sorted(heard - want)} that is not ordered, misses {sorted(want - heard)}")
            print("   ", o["es"])
            bad += 1
    if bad:
        sys.exit(f"{bad} problem(s) in the orders")
    print(f"{len(ORDERS)} orders check out")


# ---------------------------------------------------------------- audio
def assign():
    rng = random.Random(2026)
    jobs = []
    for n, o in enumerate(ORDERS, 1):
        jobs.append(dict(id=f"o{n:02d}", es=o["es"], voice=rng.choice(VOICES), rate=rng.choice(RATES),
                         want=wanted(o), gf=o["bread"] == "gf"))
    return jobs


async def make_audio(jobs, outdir):
    import edge_tts
    os.makedirs(outdir, exist_ok=True)
    mpath = os.path.join(outdir, "manifest.json")
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    todo = []
    for j in jobs:
        h = hashlib.sha1(f"{j['es']}|{j['voice']}|{j['rate']}".encode()).hexdigest()[:12]
        if manifest.get(j["id"]) != h or not os.path.exists(os.path.join(outdir, j["id"] + ".mp3")):
            todo.append((j, h))
    print(f"{len(todo)} of {len(jobs)} clips to make")
    sem = asyncio.Semaphore(3)

    async def one(j, h):
        async with sem:
            raw = os.path.join(outdir, j["id"] + ".raw.mp3")
            for attempt in range(4):
                try:
                    await edge_tts.Communicate(j["es"], j["voice"], rate=j["rate"]).save(raw)
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    await asyncio.sleep(2 * (attempt + 1))
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                            "-ac", "1", "-ar", "24000", "-b:a", "56k", os.path.join(outdir, j["id"] + ".mp3")],
                           check=True)
            os.remove(raw)
            manifest[j["id"]] = h
            print("  made", j["id"], j["voice"], j["rate"], flush=True)

    await asyncio.gather(*(one(j, h) for j, h in todo))
    json.dump(manifest, open(mpath, "w"), indent=1, sort_keys=True)


def write_data(jobs, folder):
    data = {
        "menu": [dict(id=i, kind=k, en=en, syn=syn, **({"partial": part} if part else {}))
                 for i, k, en, syn, part in MENU],
        "orders": [dict(id=j["id"], es=j["es"], file=f"audio/{j['id']}.mp3", want=j["want"], gf=j["gf"])
                   for j in jobs],
    }
    with open(os.path.join(folder, "data.js"), "w", encoding="utf8") as f:
        f.write("// Generated by scripts/sub-bar/build.py. Edit the script, not this file.\n")
        f.write("window.SUBBAR = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("wrote data.js")


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "public/sub-bar"
    check_orders()
    jobs = assign()
    if "--check" not in sys.argv:
        asyncio.run(make_audio(jobs, os.path.join(folder, "audio")))
        write_data(jobs, folder)
