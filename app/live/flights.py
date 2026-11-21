"""Live aircraft positions from OpenSky Network (public ADS-B receivers).

Anonymous access gets ~400 credits/day and a global snapshot costs 4, so
the 120s cache is what keeps this inside the free tier.
"""

import httpx

from .cache import ttl_cache

OPENSKY_URL = "https://opensky-network.org/api/states/all"


def parse_states(payload: dict) -> list[list]:
    """Compact rows for the frontend: ~10k aircraft as dicts would be
    several MB, as short arrays it's well under one."""
    flights = []
    for s in payload.get("states") or []:
        lon, lat, on_ground = s[5], s[6], s[8]
        if lon is None or lat is None or on_ground:
            continue
        flights.append([
            s[0],                       # icao24
            (s[1] or "").strip(),       # callsign
            s[2],                       # origin country
            round(lon, 3),
            round(lat, 3),
            round(s[7] or s[13] or 0),  # altitude (m), baro else geometric
            round(s[9] or 0),           # ground speed (m/s)
            round(s[10] or 0),          # heading
        ])
    return flights


@ttl_cache(120)
async def snapshot(client: httpx.AsyncClient) -> dict:
    resp = await client.get(OPENSKY_URL, timeout=30.0)
    resp.raise_for_status()
    payload = resp.json()
    flights = parse_states(payload)
    return {
        "time": payload.get("time"),
        "count": len(flights),
        "fields": ["icao24", "callsign", "country", "lon", "lat", "alt_m", "speed_ms", "heading"],
        "flights": flights,
    }
