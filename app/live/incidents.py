"""Reported strikes / armed incidents from the GDELT 2.0 event stream.

GDELT machine-codes world news into events every 15 minutes, each with a
CAMEO event code, a geocoded location and the source article URL. Raw, it
is far too noisy to plot: in one 15-minute file the generic "use
conventional military force" code was attached to an F1 race report, a
motorcycle accident and a murder trial. So events go through four filters
before reaching the map:

  1. strike-specific CAMEO codes only (aerial weapons, bombings, artillery,
     armed clashes)
  2. city-level geocodes only - country/region centroids aren't locations
  3. the source URL must contain a conflict keyword
  4. events are clustered per location, and confidence comes from how many
     *independent outlets* reported it, not how many times it was mentioned

Everything here is *reported* - pins mean "outlets reported this here",
not a verified ground truth, and the UI says so.
"""

import asyncio
import csv
import io
import re
import zipfile
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from .cache import ttl_cache

LASTUPDATE_URL = "https://data.gdeltproject.org/gdeltv2/lastupdate.txt"
EXPORT_URL = "https://data.gdeltproject.org/gdeltv2/{stamp}.export.CSV.zip"
WINDOW_HOURS = 6

CATEGORIES = {
    "airstrike": {"195", "1951", "1952"},
    "bombing": {"183", "1831", "1832", "1833", "1834"},
    "shelling": {"194"},
    "armed clash": {"190", "193", "196"},
}
CODE_TO_CATEGORY = {code: cat for cat, codes in CATEGORIES.items() for code in codes}

# Whole words only: a bare "war" substring matched "toward" and "software",
# "killed" let through crime stories, and plain "strike" matched a student
# walkout - all seen in real output.
CONFLICT_KEYWORDS = re.compile(
    r"\b(?:airstrikes?|missiles?|drones?|bomb(?:s|ing|ings|ed)?|shell(?:ing|ed)|rockets?|"
    r"attack(?:s|ed)?|raids?|explosions?|blasts?|artillery|offensive|clash(?:es)?|ceasefire|"
    r"militants?|troops|army|military|war|idf|hezbollah|hamas|houthis?)\b",
    re.IGNORECASE,
)

CITY_LEVEL_GEO = {"3", "4"}  # 3 = US city, 4 = world city

# Labelled, not filtered - the reader decides how much weight to give them
STATE_AFFILIATED = {
    "presstv.ir", "presstv.co.uk", "rt.com", "tass.com", "tass.ru", "sputnikglobe.com",
    "cgtn.com", "globaltimes.cn", "xinhuanet.com", "kcna.kp", "irna.ir", "tasnimnews.com",
}

# GDELT 2.0 export column indexes
C_CODE, C_MENTIONS, C_GEO_TYPE, C_GEO_NAME, C_GEO_CC = 26, 31, 51, 52, 53
C_LAT, C_LON, C_FEATURE, C_ADDED, C_URL = 56, 57, 58, 59, 60
C_ACTOR1, C_ACTOR2 = 6, 16


def _domain(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def window_stamps(latest: str, hours: int = WINDOW_HOURS) -> list[str]:
    end = datetime.strptime(latest, "%Y%m%d%H%M%S")
    return [(end - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(hours * 4)]


def filter_events(rows: list[list[str]]) -> tuple[list[list[str]], dict]:
    funnel = {"raw": len(rows), "strike_codes": 0, "city_level": 0, "keyword_match": 0}
    kept = []
    for r in rows:
        if len(r) < 61 or r[C_CODE] not in CODE_TO_CATEGORY:
            continue
        funnel["strike_codes"] += 1
        if r[C_GEO_TYPE] not in CITY_LEVEL_GEO or not r[C_LAT]:
            continue
        funnel["city_level"] += 1
        if not CONFLICT_KEYWORDS.search(urlparse(r[C_URL]).path):
            continue
        funnel["keyword_match"] += 1
        kept.append(r)
    return kept, funnel


def cluster(rows: list[list[str]]) -> list[dict]:
    places: dict[str, dict] = {}
    for r in rows:
        key = r[C_FEATURE] or f"{r[C_LAT]},{r[C_LON]}"
        p = places.setdefault(key, {
            "place": r[C_GEO_NAME],
            "country_code": r[C_GEO_CC],
            "lat": float(r[C_LAT]),
            "lon": float(r[C_LON]),
            "categories": {},
            "actors": set(),
            "sources": {},
            "mentions": 0,
            "first_seen": r[C_ADDED],
            "last_seen": r[C_ADDED],
        })
        cat = CODE_TO_CATEGORY[r[C_CODE]]
        p["categories"][cat] = p["categories"].get(cat, 0) + 1
        p["actors"].update(a for a in (r[C_ACTOR1], r[C_ACTOR2]) if a)
        p["sources"].setdefault(_domain(r[C_URL]), r[C_URL])
        p["mentions"] += int(r[C_MENTIONS] or 0)
        p["first_seen"] = min(p["first_seen"], r[C_ADDED])
        p["last_seen"] = max(p["last_seen"], r[C_ADDED])

    incidents = []
    for p in places.values():
        n_outlets = len(p["sources"])
        incidents.append({
            **{k: p[k] for k in ("place", "country_code", "lat", "lon", "mentions", "first_seen", "last_seen")},
            "category": max(p["categories"], key=p["categories"].get),
            "categories": p["categories"],
            "actors": sorted(p["actors"])[:6],
            "outlets": n_outlets,
            "confidence": "high" if n_outlets >= 3 else "medium" if n_outlets == 2 else "low",
            "sources": [
                {"domain": d, "url": u, "state_affiliated": d in STATE_AFFILIATED}
                for d, u in list(p["sources"].items())[:8]
            ],
        })
    return sorted(incidents, key=lambda i: (i["outlets"], i["mentions"]), reverse=True)


_file_cache: dict[str, list[list[str]]] = {}


async def _load_file(stamp: str, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> list[list[str]]:
    if stamp in _file_cache:
        return _file_cache[stamp]
    async with sem:
        try:
            resp = await client.get(EXPORT_URL.format(stamp=stamp), timeout=30.0)
            resp.raise_for_status()
        except httpx.HTTPError:
            return []  # GDELT occasionally skips a 15-min slot
    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        text = io.TextIOWrapper(z.open(z.namelist()[0]), "utf-8", errors="replace")
        rows = list(csv.reader(text, delimiter="\t"))
    _file_cache[stamp] = rows  # export files never change once published
    return rows


@ttl_cache(600)
async def reported(client: httpx.AsyncClient) -> dict:
    resp = await client.get(LASTUPDATE_URL, timeout=15.0)
    resp.raise_for_status()
    latest = resp.text.split()[2].rsplit("/", 1)[-1].split(".")[0]
    stamps = window_stamps(latest)

    sem = asyncio.Semaphore(6)
    files = await asyncio.gather(*(_load_file(s, client, sem) for s in stamps))
    for old in set(_file_cache) - set(stamps):
        del _file_cache[old]

    rows = [r for f in files for r in f]
    kept, funnel = filter_events(rows)
    incidents = cluster(kept)
    funnel["locations"] = len(incidents)

    return {
        "window_hours": WINDOW_HOURS,
        "latest_update": datetime.strptime(latest, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).isoformat(),
        "funnel": funnel,
        "incidents": incidents,
    }
