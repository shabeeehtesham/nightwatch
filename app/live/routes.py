"""Where a flight is going: origin and destination for a callsign.

Aircraft don't broadcast their route, only position. adsbdb.com keeps a
community-maintained callsign -> route table. It's usually right for
scheduled flights but can be stale when an airline reuses a flight
number, so the frontend checks the plane is actually near the line
between the two airports before trusting it.
"""

import httpx

from .cache import ttl_cache

ADSBDB_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"

CALLSIGN_PATTERN = r"^[A-Za-z0-9]{3,8}$"


def _airport(a: dict) -> dict:
    return {
        "iata": a.get("iata_code"),
        "icao": a.get("icao_code"),
        "name": a.get("name"),
        "city": a.get("municipality"),
        "country": a.get("country_name"),
        "lat": a.get("latitude"),
        "lon": a.get("longitude"),
    }


def parse_route(payload: dict) -> dict | None:
    route = (payload.get("response") or {})
    route = route.get("flightroute") if isinstance(route, dict) else None
    if not route or not route.get("origin") or not route.get("destination"):
        return None
    origin, dest = _airport(route["origin"]), _airport(route["destination"])
    if None in (origin["lat"], origin["lon"], dest["lat"], dest["lon"]):
        return None
    airline = route.get("airline") or {}
    return {
        "callsign": route.get("callsign_icao") or route.get("callsign"),
        "flight_number": route.get("callsign_iata"),
        "airline": airline.get("name"),
        "origin": origin,
        "destination": dest,
        "source": "adsbdb.com",
    }


# Routes change rarely; 6h keeps repeat lookups (every tracked plane) cheap
@ttl_cache(6 * 3600)
async def lookup(callsign: str, client: httpx.AsyncClient) -> dict | None:
    resp = await client.get(ADSBDB_URL.format(callsign=callsign.upper()), timeout=10.0)
    if resp.status_code == 404:
        return None  # callsign not in the database - a normal answer, cache it
    resp.raise_for_status()
    return parse_route(resp.json())
