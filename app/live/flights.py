"""Live aircraft positions.

Primary source is OpenSky Network: one call returns the whole world.
Anonymous access gets ~400 credits/day and a global snapshot costs 4, so
the 120s cache keeps this inside the free tier.

OpenSky refuses connections from many cloud hosts (it times out from
Render), so when it fails the feed falls back to adsb.fi's open data API.
That API only answers "aircraft within 250 nm of a point" at 1 request/s,
so a background sweep walks a grid of circles over the busy airspace.
The sweep only runs while someone is actually looking at the map.

adsb.fi also backs the single-aircraft search and tracking, since it can
look a plane up by callsign, ICAO hex or registration.
"""

import asyncio
import math
import re
import time

import httpx

from .cache import ttl_cache

OPENSKY_URL = "https://opensky-network.org/api/states/all"
ADSBFI_URL = "https://opendata.adsb.fi/api/v2"

FIELDS = ["icao24", "callsign", "country", "lon", "lat", "alt_m", "speed_ms", "heading", "registration", "type"]

FT_TO_M = 0.3048
KT_TO_MS = 0.514444

OPENSKY_RETRY_S = 600   # after a failure, don't make every request wait on a 30s timeout
SWEEP_IDLE_S = 300      # stop sweeping once nobody has asked for flights for 5 min
SWEEP_MAX_AGE_S = 400   # a full sweep takes ~170s; keep planes for two of them
RADIUS_NM = 250         # adsb.fi's maximum

# Busy airspace as (lat_min, lat_max, lon_min, lon_max). Oceans and empty
# land are left out on purpose: each circle costs one rate-limited request.
SWEEP_REGIONS = [
    (25, 50, -125, -67),   # North America
    (36, 60, -10, 32),     # Europe
    (22, 38, 34, 58),      # Middle East / Gulf
    (8, 30, 70, 90),       # India
    (22, 42, 100, 142),    # China, Korea, Japan
    (-8, 22, 95, 125),     # Southeast Asia
    (-38, -27, 115, 153),  # southern Australia
    (-35, -5, -60, -35),   # Brazil / southern South America
]


def sweep_points(spacing_deg: float = 6.5) -> list[tuple[float, float]]:
    """Grid of circle centres over SWEEP_REGIONS. Longitude spacing widens
    with latitude so the circles stay roughly the same distance apart."""
    points = []
    for lat0, lat1, lon0, lon1 in SWEEP_REGIONS:
        lat = lat0 + spacing_deg / 2
        while lat < lat1 + spacing_deg / 2:
            lon_step = spacing_deg / max(math.cos(math.radians(lat)), 0.3)
            lon = lon0 + lon_step / 2
            while lon < lon1 + lon_step / 2:
                points.append((round(lat, 2), round(lon, 2)))
                lon += lon_step
            lat += spacing_deg
    return points


def parse_states(payload: dict) -> list[list]:
    """OpenSky state vectors -> compact rows. ~10k aircraft as dicts would
    be several MB, as short arrays it's well under one."""
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
            None,                       # registration (not in OpenSky states)
            None,                       # aircraft type
        ])
    return flights


def parse_adsb(ac: dict) -> list | None:
    """One readsb-format aircraft (adsb.fi, adsb.lol, ...) -> the same
    compact row as OpenSky. readsb uses feet and knots; convert to metres
    and m/s so the frontend has one format."""
    lat, lon, alt = ac.get("lat"), ac.get("lon"), ac.get("alt_baro")
    if lat is None or lon is None or alt == "ground":
        return None
    alt_ft = alt if isinstance(alt, (int, float)) else ac.get("alt_geom") or 0
    return [
        (ac.get("hex") or "").lstrip("~"),
        (ac.get("flight") or "").strip(),
        None,
        round(lon, 3),
        round(lat, 3),
        round(alt_ft * FT_TO_M),
        round((ac.get("gs") or 0) * KT_TO_MS),
        round(ac.get("track") or ac.get("true_heading") or 0),
        ac.get("r"),
        ac.get("t"),
    ]


def _aircraft(payload: dict) -> list[dict]:
    # the point endpoint calls the list "aircraft", the lookups call it "ac"
    return payload.get("aircraft") or payload.get("ac") or []


@ttl_cache(120)
async def opensky_snapshot(client: httpx.AsyncClient) -> dict:
    # Short connect timeout: where OpenSky is blocked it never answers, and
    # the fallback shouldn't make the first page load wait 30s to find out.
    resp = await client.get(OPENSKY_URL, timeout=httpx.Timeout(30.0, connect=8.0))
    resp.raise_for_status()
    payload = resp.json()
    return {"time": payload.get("time"), "flights": parse_states(payload)}


class AdsbFi:
    """adsb.fi client that keeps every request (sweep and search) under
    its documented 1 request/second limit."""

    MIN_GAP_S = 1.1

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def get(self, path: str) -> list[dict]:
        async with self._lock:
            wait = self._last + self.MIN_GAP_S - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                resp = await self.client.get(f"{ADSBFI_URL}/{path}", timeout=15.0)
            finally:
                self._last = time.monotonic()
        resp.raise_for_status()
        return _aircraft(resp.json())


SEARCH_PATTERN = r"^[A-Za-z0-9-]{2,10}$"
HEX_PATTERN = re.compile(r"^[0-9a-fA-F]{6}$")


class FlightFeed:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.adsb = AdsbFi(client)
        self.points = sweep_points()
        self.opensky_down_until = 0.0
        self.opensky_error: str | None = None
        self._opensky_rows: list[list] = []
        self._seen: dict[str, tuple[float, list]] = {}  # hex -> (seen_at, row)
        self._sweep_task: asyncio.Task | None = None
        self._last_wanted = 0.0
        self.sweep_errors = 0
        self.sweeps_done = 0

    # ---- global snapshot -------------------------------------------------

    async def snapshot(self) -> dict:
        if time.monotonic() >= self.opensky_down_until:
            try:
                data = await opensky_snapshot(self.client)
                self.opensky_error = None
                self._opensky_rows = data["flights"]
                return self._payload(data["flights"], "OpenSky Network", "global", data["time"])
            except (httpx.HTTPError, ValueError) as exc:
                self.opensky_error = type(exc).__name__
                self.opensky_down_until = time.monotonic() + OPENSKY_RETRY_S

        self._ensure_sweep()
        rows = self._sweep_rows()
        if not rows and self.sweep_errors and not self.sweeps_done:
            raise httpx.ConnectError("OpenSky and adsb.fi both unreachable")
        return self._payload(rows, "adsb.fi", "regional sweep", int(time.time()), warming=self.sweeps_done == 0)

    @staticmethod
    def _payload(rows, source, coverage, ts, warming=False) -> dict:
        return {
            "time": ts,
            "source": source,
            "coverage": coverage,
            "warming": warming,
            "count": len(rows),
            "fields": FIELDS,
            "flights": rows,
        }

    def _sweep_rows(self) -> list[list]:
        now = time.monotonic()
        return [row for seen_at, row in self._seen.values() if now - seen_at < SWEEP_MAX_AGE_S]

    def _ensure_sweep(self) -> None:
        self._last_wanted = time.monotonic()
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = asyncio.create_task(self._sweep())

    async def _sweep(self) -> None:
        while time.monotonic() - self._last_wanted < SWEEP_IDLE_S:
            for lat, lon in self.points:
                try:
                    found = await self.adsb.get(f"lat/{lat}/lon/{lon}/dist/{RADIUS_NM}")
                except (httpx.HTTPError, ValueError):
                    self.sweep_errors += 1
                    continue
                self.ingest(found)
            self.sweeps_done += 1
            cutoff = time.monotonic() - SWEEP_MAX_AGE_S
            self._seen = {k: v for k, v in self._seen.items() if v[0] >= cutoff}

    def ingest(self, aircraft: list[dict]) -> None:
        now = time.monotonic()
        for ac in aircraft:
            if row := parse_adsb(ac):
                self._seen[row[0]] = (now, row)

    def status(self) -> dict:
        return {
            "source": "OpenSky Network" if self.opensky_error is None else "adsb.fi",
            "opensky_error": self.opensky_error,
            "sweep_running": self._sweep_task is not None and not self._sweep_task.done(),
            "sweep_points": len(self.points),
            "sweeps_done": self.sweeps_done,
            "sweep_errors": self.sweep_errors,
        }

    # ---- single aircraft -------------------------------------------------

    async def find(self, query: str) -> list[list]:
        """Look a plane up by callsign (BAW1), registration (G-EUYS) or
        ICAO hex (406a02). adsb.fi is asked directly so planes outside
        the swept regions are found too; the local snapshot is the
        fallback if adsb.fi can't be reached."""
        q = query.strip()
        paths = []
        if HEX_PATTERN.match(q):
            paths.append(f"hex/{q.lower()}")
        if "-" in q:
            paths.append(f"registration/{q.upper()}")
        else:
            paths.append(f"callsign/{q.upper()}")
            paths.append(f"registration/{q.upper()}")  # e.g. N12345 has no dash

        results: dict[str, list] = {}
        for path in paths:
            try:
                for ac in await self.adsb.get(path):
                    if row := parse_adsb(ac):
                        results[row[0]] = row
            except (httpx.HTTPError, ValueError):
                continue
            if results:
                break
        if not results:
            results = {r[0]: r for r in self.local_matches(q)}
        return list(results.values())[:10]

    async def position(self, icao24: str) -> list | None:
        try:
            for ac in await self.adsb.get(f"hex/{icao24.lower()}"):
                if row := parse_adsb(ac):
                    return row
        except (httpx.HTTPError, ValueError):
            pass
        matches = self.local_matches(icao24)
        return matches[0] if matches else None

    def local_matches(self, q: str) -> list[list]:
        q = q.lower()
        rows = self._sweep_rows() + self._opensky_rows
        return [r for r in rows if q in (r[0], (r[1] or "").lower(), (r[8] or "").lower())]
