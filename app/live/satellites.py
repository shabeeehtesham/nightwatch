"""Orbital elements (TLEs) only - the browser propagates positions itself
with satellite.js, so satellites move smoothly without polling.

CelesTrak is the canonical source but goes down under load, so there's a
fallback mirror.
"""

import httpx

from .cache import ttl_cache

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php"
MIRROR_URL = "https://tle.ivanstanojevic.me/api/tle/"

GROUPS = {
    "stations": "Space stations",
    "visual": "Brightest objects",
    "gps-ops": "GPS",
    "weather": "Weather",
}


def parse_tle_text(text: str, group: str) -> list[dict]:
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    sats = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i : i + 3]
        if l1.startswith("1 ") and l2.startswith("2 "):
            sats.append({"name": name.strip(), "line1": l1, "line2": l2, "group": group})
    return sats


async def _from_celestrak(client: httpx.AsyncClient) -> list[dict]:
    sats = []
    for group in GROUPS:
        resp = await client.get(CELESTRAK_URL, params={"GROUP": group, "FORMAT": "tle"}, timeout=20.0)
        resp.raise_for_status()
        sats.extend(parse_tle_text(resp.text, group))
    return sats


async def _from_mirror(client: httpx.AsyncClient) -> list[dict]:
    sats = []
    for search, group in (("ISS", "stations"), ("NAVSTAR", "gps-ops"), ("NOAA", "weather"), ("STARLINK", "visual")):
        resp = await client.get(MIRROR_URL, params={"search": search, "page-size": 100}, timeout=20.0)
        resp.raise_for_status()
        for m in resp.json().get("member", []):
            sats.append({"name": m["name"], "line1": m["line1"], "line2": m["line2"], "group": group})
    return sats


@ttl_cache(6 * 3600)
async def elements(client: httpx.AsyncClient) -> dict:
    try:
        sats, source = await _from_celestrak(client), "celestrak"
    except httpx.HTTPError:
        sats, source = await _from_mirror(client), "mirror"

    seen, unique = set(), []
    for s in sats:
        norad = s["line1"][2:7]
        if norad not in seen:
            seen.add(norad)
            unique.append(s)
    return {"source": source, "groups": GROUPS, "count": len(unique), "satellites": unique}
