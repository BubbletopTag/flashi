#!/usr/bin/env python3
"""Sub Bar: check the orders, make the audio, write data.js.

Two games share one menu: server mode (50 Spanish orders to hear and type in English) and customer mode
(50 different English subs to order in Spanish, with a model answer to listen to).

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
# One row per ingredient. `en` / `syn` are how it is said in English (server mode grades English answers);
# `esLabel` / `esBare` / `es` are how it is said in Spanish (customer mode grades Spanish answers).
# `partial` words earn half credit: a wrap, without saying which wrap.
def M(id, kind, en, syn, es_label, es_bare, es, partial=(), es_partial=()):
    row = dict(id=id, kind=kind, en=en, syn=list(syn), esLabel=es_label, esBare=es_bare, es=list(es))
    if partial:
        row["partial"] = list(partial)
    if es_partial:
        row["esPartial"] = list(es_partial)
    return row


MENU = [
    M("white", "bread", "white bread", ["white bread", "white sub", "white roll", "white bun", "white"],
      "el pan blanco", "pan blanco", ["pan blanco", "blanco"]),
    M("wheat", "bread", "wheat bread", ["wheat bread", "whole wheat bread", "whole wheat", "wheat", "whole grain bread",
                                        "whole grain", "brown bread", "multigrain bread", "multigrain"],
      "el pan integral", "pan integral", ["pan integral", "pan de trigo integral", "pan de trigo", "pan multigrano", "integral"]),
    M("gf", "bread", "gluten-free bread", ["gluten free bread", "gluten free", "gluten", "gf bread", "gf"],
      "el pan sin gluten", "pan sin gluten", ["pan sin gluten", "pan libre de gluten", "sin gluten", "libre de gluten", "gluten"]),
    M("flour", "bread", "flour tortilla", ["flour tortilla", "flour wrap", "plain tortilla", "plain wrap",
                                           "regular tortilla", "regular wrap", "white tortilla", "white wrap"],
      "la tortilla de harina", "tortilla de harina",
      ["tortilla de harina", "tortilla de trigo", "tortilla blanca", "tortilla normal"], ["wrap", "tortilla"], ["tortilla", "wrap"]),
    M("spinachT", "bread", "spinach tortilla", ["spinach tortilla", "spinach wrap", "green tortilla", "green wrap",
                                                "spinach flatbread"],
      "la tortilla de espinaca", "tortilla de espinaca", ["tortilla de espinaca", "tortilla verde"],
      ["wrap", "tortilla"], ["tortilla", "wrap"]),
    M("tomatoT", "bread", "tomato tortilla", ["tomato tortilla", "tomato wrap", "red tortilla", "red wrap"],
      "la tortilla de tomate", "tortilla de tomate", ["tortilla de tomate", "tortilla roja"],
      ["wrap", "tortilla"], ["tortilla", "wrap"]),

    M("bacon", "filling", "bacon", ["bacon"], "el tocino", "tocino", ["tocino", "bacon", "beicon", "tocineta"]),
    M("capicola", "filling", "capicola", ["capicola", "capicolla", "capocollo", "coppa"],
      "la capicola", "capicola", ["capicola", "capicolla", "capi cola", "capocollo", "coppa"]),
    M("ham", "filling", "ham", ["ham"], "el jamón", "jamón", ["jamon"]),
    M("turkey", "filling", "turkey", ["turkey", "turkey breast"], "el pavo", "pavo", ["pavo"]),
    M("salami", "filling", "salami", ["salami"], "el salami", "salami", ["salami"]),
    M("pepperoni", "filling", "pepperoni", ["pepperoni"], "el pepperoni", "pepperoni", ["pepperoni", "peperoni", "pepe roni"]),
    M("tuna", "filling", "tuna", ["tuna", "tuna salad"], "el atún", "atún", ["atun"]),
    M("chickensalad", "filling", "chicken salad", ["chicken salad", "chicken"],
      "la ensalada de pollo", "ensalada de pollo", ["ensalada de pollo", "pollo"]),
    M("hummus", "filling", "hummus", ["hummus", "houmous", "humus"], "el hummus", "hummus",
      ["hummus", "humus", "jummus", "hommus", "mus"]),

    M("american", "cheese", "American cheese", ["american cheese", "american"],
      "el queso americano", "queso americano", ["queso americano", "americano"]),
    M("provolone", "cheese", "provolone", ["provolone cheese", "provolone"],
      "el queso provolone", "queso provolone", ["queso provolone", "provolone"]),
    M("swiss", "cheese", "Swiss cheese", ["swiss cheese", "swiss"],
      "el queso suizo", "queso suizo", ["queso suizo", "suizo", "queso swiss", "swiss"]),
    M("cheddar", "cheese", "cheddar", ["cheddar cheese", "cheddar"],
      "el queso cheddar", "queso cheddar", ["queso cheddar", "cheddar", "chedar"]),

    M("lettuce", "veg", "lettuce", ["lettuce"], "la lechuga", "lechuga", ["lechuga"]),
    M("spinach", "veg", "spinach", ["spinach", "spinach leaves", "baby spinach"], "la espinaca", "espinaca", ["espinaca"]),
    M("tomato", "veg", "tomatoes", ["tomato", "tomatoes"], "los tomates", "tomates", ["tomate"]),
    M("jalapeno", "veg", "jalapeños", ["jalapeno", "jalapeno pepper", "jalapeno peppers"],
      "los jalapeños", "jalapeños", ["jalapeno", "chile jalapeno"]),
    M("bananapepper", "veg", "banana peppers", ["banana pepper", "banana peppers", "banana"],
      "los pimientos banana", "pimientos banana",
      ["pimiento banana", "chile banana", "pimiento amarillo", "chile guero", "pimiento guero", "banana"]),
    M("olive", "veg", "black olives", ["black olive", "black olives", "olive", "olives"],
      "las aceitunas negras", "aceitunas negras", ["aceituna negra", "aceituna", "oliva negra", "oliva"]),
    M("onion", "veg", "onions", ["onion", "onions", "red onion"], "las cebollas", "cebollas", ["cebolla"]),
    M("pickle", "veg", "dill pickles", ["dill pickle", "dill pickles", "pickle", "pickles", "dill"],
      "los pepinillos", "pepinillos", ["pepinillo", "pepinillo en vinagre", "pickle", "encurtido"]),

    M("mayo", "sauce", "mayo", ["mayonnaise", "mayo"], "la mayonesa", "mayonesa", ["mayonesa", "mayo"]),
    M("chipotle", "sauce", "chipotle mayo", ["chipotle mayonnaise", "chipotle mayo", "chipotle sauce", "chipotle",
                                             "mayo with chipotle", "chipotle and mayo", "spicy mayo"],
      "la mayonesa chipotle", "mayonesa chipotle",
      ["mayonesa chipotle", "mayonesa con chipotle", "salsa chipotle", "aderezo chipotle", "mayo chipotle", "chipotle"]),
    M("mustard", "sauce", "mustard", ["mustard", "yellow mustard"], "la mostaza", "mostaza", ["mostaza"]),
    M("dressing", "sauce", "salad dressing", ["salad dressing", "dressing", "vinaigrette", "ranch"],
      "el aderezo", "aderezo",
      ["aderezo para ensalada", "aderezo de ensalada", "aderezo", "vinagreta", "aliño", "ranch"]),

    M("toasted", "extra", "toasted", ["toasted", "toast", "toasty", "heated", "warmed"], "tostado", "tostado",
      ["tostado", "tostada", "tostar", "tostarlo", "tostarla", "tostadito", "calentado", "calentadito"]),
]

# What each item sounds like in the Spanish lines the customers say. Only used to check the orders.
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
BARE = {m["id"]: m["esBare"] for m in MENU}


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

# --- customer mode: 50 different subs the player orders in Spanish for a friend.
# Together they use every ingredient at least once (checked below). The Spanish model answer is built from
# the pieces, so it always matches the sub.
def S(bread, fill, cheese, veg, sauce, toasted, more):
    return dict(bread=bread, fill=fill.split(), cheese=cheese.split(), veg=veg.split(), sauce=sauce.split(),
                toasted=toasted, more=more)


SUBS = [
    S("white", "turkey", "swiss", "lettuce tomato", "mustard", False, ""),
    S("wheat", "ham turkey", "american", "lettuce tomato onion", "mayo", True, ""),
    S("white", "salami pepperoni", "provolone", "", "chipotle", True, ""),
    S("gf", "turkey", "provolone", "lettuce tomato", "", False, ""),
    S("flour", "chickensalad", "cheddar", "lettuce tomato", "dressing", False, ""),
    S("spinachT", "hummus", "", "lettuce tomato olive onion", "", True, ""),
    S("tomatoT", "bacon turkey", "swiss", "lettuce tomato", "mayo", False, ""),
    S("white", "bacon", "cheddar", "lettuce tomato", "mayo", True, ""),
    S("wheat", "tuna", "swiss", "onion tomato", "", True, ""),
    S("white", "capicola ham salami", "provolone", "olive bananapepper", "dressing", True, ""),
    S("flour", "pepperoni", "cheddar", "jalapeno onion", "chipotle", True, ""),
    S("gf", "ham", "american", "pickle", "mustard", True, ""),
    S("white", "chickensalad", "american", "lettuce pickle", "mayo", False, ""),
    S("wheat", "hummus", "", "lettuce spinach tomato pickle", "dressing", False, ""),
    S("spinachT", "turkey bacon", "provolone", "spinach tomato", "chipotle", True, ""),
    S("tomatoT", "salami", "provolone", "bananapepper olive", "dressing", False, ""),
    S("white", "ham", "swiss", "lettuce", "mustard", False, ""),
    S("wheat", "pepperoni salami", "american", "jalapeno bananapepper", "chipotle", True, ""),
    S("flour", "tuna", "", "lettuce pickle onion", "mayo", False, ""),
    S("gf", "tuna", "cheddar", "tomato onion", "dressing", False, ""),
    S("white", "turkey ham", "cheddar", "lettuce tomato pickle", "mayo mustard", False, ""),
    S("wheat", "bacon", "provolone", "lettuce tomato", "chipotle", True, ""),
    S("spinachT", "chickensalad", "swiss", "spinach tomato", "mayo", False, ""),
    S("tomatoT", "hummus ham", "american", "lettuce olive", "", True, ""),
    S("white", "salami", "provolone", "lettuce tomato onion", "dressing", False, ""),
    S("flour", "turkey", "american", "lettuce tomato jalapeno", "chipotle", True, ""),
    S("gf", "salami pepperoni", "provolone", "", "chipotle", True, ""),
    S("white", "tuna chickensalad", "", "pickle", "mustard", False, ""),
    S("wheat", "capicola turkey", "swiss", "bananapepper lettuce", "dressing", True, ""),
    S("spinachT", "bacon", "cheddar", "tomato onion", "mayo", True, ""),
    S("tomatoT", "pepperoni", "provolone", "olive jalapeno", "", True, ""),
    S("white", "hummus", "", "lettuce spinach tomato jalapeno bananapepper olive onion pickle", "mustard", False, ""),
    S("flour", "ham turkey bacon", "american cheddar", "lettuce", "mayo", True, ""),
    S("gf", "chickensalad", "swiss", "lettuce pickle", "mustard", False, ""),
    S("wheat", "turkey", "", "spinach tomato onion", "dressing", False, ""),
    S("white", "pepperoni", "american", "jalapeno", "chipotle", True, "jalapeno"),
    S("flour", "hummus tuna", "", "lettuce olive", "chipotle", False, ""),
    S("spinachT", "capicola salami ham", "provolone", "lettuce bananapepper", "dressing", True, ""),
    S("tomatoT", "chickensalad turkey", "cheddar", "tomato pickle", "mayo", False, ""),
    S("white", "bacon capicola", "swiss", "onion olive", "mustard", True, "mustard"),
    S("wheat", "ham", "cheddar", "lettuce tomato jalapeno", "mayo", False, "tomato"),
    S("gf", "hummus", "", "lettuce tomato olive", "dressing", False, ""),
    S("white", "turkey", "provolone", "lettuce", "chipotle", True, "chipotle"),
    S("flour", "salami", "swiss", "onion pickle", "mustard", False, ""),
    S("spinachT", "tuna", "american", "lettuce tomato", "mayo", True, ""),
    S("tomatoT", "ham", "swiss", "lettuce spinach", "dressing", False, ""),
    S("wheat", "pepperoni", "provolone", "bananapepper", "", True, ""),
    S("white", "hummus chickensalad", "cheddar", "tomato", "chipotle", False, ""),
    S("gf", "bacon turkey", "american", "lettuce tomato", "mayo", True, "lettuce"),
    S("flour", "bacon capicola ham turkey salami pepperoni", "provolone", "", "mustard", True, ""),
]


def join_es(xs):
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " y " + xs[-1]


OPENERS = ["Hola, quisiera", "Buenas, me das", "Para mí,", "Hola, me pones", "Quisiera", "Buenas tardes, quisiera"]


def model_answer(o, i):
    """How a local would order this sub, built from the pieces. Different openers and ways to ask for it toasted."""
    tortilla = o["bread"] in ("flour", "spinachT", "tomatoT")
    base = ("una " if tortilla else "un sub de ") + BARE[o["bread"]]
    mains = [BARE[x] for x in o["fill"] + o["cheese"]]
    parts = []
    if mains:
        parts.append("con " + join_es(mains))
    if o["veg"]:
        parts.append("con " + join_es([BARE[x] for x in o["veg"]]))
    if o["sauce"]:
        parts.append("con " + join_es([BARE[x] for x in o["sauce"]]))
    text = f"{OPENERS[i % len(OPENERS)]} {base}" + (" " + ", ".join(parts) if parts else "")
    f = "a" if tortilla else "o"
    if o["toasted"]:
        text += [f". Tostad{f}, por favor.", f". ¿Me l{f} puede tostar?", f". L{f} quiero tostad{f}."][i % 3]
    else:
        text += "."
    if o["more"]:
        text += f" Y un poco más de {BARE[o['more']]}, por favor."
    elif not o["toasted"]:
        text = text[:-1] + ", por favor."
    return text


for _i, _s in enumerate(SUBS):
    _s["es"] = model_answer(_s, _i)

PR_VOICES = ["es-PR-KarinaNeural", "es-PR-VictorNeural"]

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
        assert o["more"] in o["veg"] + o["sauce"], f"more={o['more']} is not on the order: {o.get('es')}"
        ids.append("more:" + o["more"])
    return ids


def check_orders():
    known = {m["id"] for m in MENU}
    bad = 0
    for kind, group in (("order", ORDERS), ("sub", SUBS)):
        for n, o in enumerate(group, 1):
            ids = wanted(o)
            for i in ids:
                if not i.startswith("more:") and i not in known:
                    print(f"{kind} {n}: unknown item {i}")
                    bad += 1
            want = {i if not i.startswith("more:") else "more" for i in ids}
            heard = spoken_items(o["es"])
            if want != heard:
                print(f"{kind} {n}: says {sorted(heard - want)} that is not ordered, misses {sorted(want - heard)}")
                print("   ", o["es"])
                bad += 1
        used = {i for o in group for i in wanted(o) if not i.startswith("more:")}
        if known - used:
            print(f"{kind}s never use: {sorted(known - used)}")
            bad += 1
        if len(group) != 50:
            print(f"expected 50 {kind}s, found {len(group)}")
            bad += 1
    distinct = {tuple(sorted(wanted(s))) for s in SUBS}
    if len(distinct) != len(SUBS):
        print(f"only {len(distinct)} of {len(SUBS)} subs are different")
        bad += 1
    if bad:
        sys.exit(f"{bad} problem(s) in the orders")
    print(f"{len(ORDERS)} orders and {len(SUBS)} different subs check out; every ingredient is used in both")


# ---------------------------------------------------------------- audio
def assign():
    rng = random.Random(2026)
    jobs = []
    for n, o in enumerate(ORDERS, 1):               # same draws as before, so these clips are not remade
        jobs.append(dict(id=f"o{n:02d}", es=o["es"], voice=rng.choice(VOICES), rate=rng.choice(RATES),
                         want=wanted(o), gf=o["bread"] == "gf"))
    rng = random.Random(77)
    for n, s in enumerate(SUBS, 1):                 # the worker's model answers, in Puerto Rican voices
        jobs.append(dict(id=f"s{n:02d}", es=s["es"], voice=rng.choice(PR_VOICES), rate="-5%", want=wanted(s)))
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
    return manifest


def write_data(jobs, folder, manifest):
    data = {
        "menu": MENU,
        "orders": [dict(id=j["id"], es=j["es"], file=f"audio/{j['id']}.mp3", want=j["want"], gf=j["gf"])
                   for j in jobs if j["id"].startswith("o")],
        "subs": [dict(id=j["id"], es=j["es"], file=f"audio/{j['id']}.mp3", want=j["want"])
                 for j in jobs if j["id"].startswith("s")],
    }
    # names the offline cache: changes whenever any clip, the menu or an order changes
    build = hashlib.sha1((json.dumps(data, sort_keys=True) + json.dumps(manifest, sort_keys=True)).encode()).hexdigest()[:10]
    data = {"build": build, **data}
    with open(os.path.join(folder, "data.js"), "w", encoding="utf8") as f:
        f.write("// Generated by scripts/sub-bar/build.py. Edit the script, not this file.\n")
        f.write("globalThis.SUBBAR = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("wrote data.js, build", build)


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "public/sub-bar"
    check_orders()
    jobs = assign()
    if "--check" not in sys.argv:
        manifest = asyncio.run(make_audio(jobs, os.path.join(folder, "audio")))
        write_data(jobs, folder, manifest)
