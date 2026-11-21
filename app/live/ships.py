"""Live vessel tracking from aisstream.io (AIS transponder feed) plus a
chokepoint monitor.

Ships broadcast AIS position reports; this keeps one websocket open,
holds the latest report per vessel (MMSI) in memory, and every few
minutes snapshots how many ships are inside each chokepoint box and which
way they're heading. That time series is what shows rerouting: if
Hormuz or Bab-el-Mandeb traffic drops while Cape of Good Hope traffic
rises, ships are going the long way round.

Caveats: AIS is self-reported and receiver coverage is mostly coastal, and
naval vessels usually don't transmit at all.
"""

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import websockets

log = logging.getLogger(__name__)

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
STALE_AFTER_S = 30 * 60
SNAPSHOT_EVERY_S = 5 * 60
HISTORY_FILE = Path(__file__).resolve().parents[2] / "data" / "chokepoint_history.jsonl"


@dataclass(frozen=True)
class Chokepoint:
    name: str
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    # course over ground pointing "toward A"; anything within 90 degrees counts as A
    bearing_a: float
    label_a: str
    label_b: str

    def contains(self, lat: float, lon: float) -> bool:
        return self.lat_min <= lat <= self.lat_max and self.lon_min <= lon <= self.lon_max


CHOKEPOINTS = (
    Chokepoint("Strait of Hormuz", 25.8, 27.2, 55.8, 57.2, 300, "into the Gulf", "out to Gulf of Oman"),
    Chokepoint("Bab-el-Mandeb", 12.3, 13.0, 43.0, 43.7, 340, "into the Red Sea", "out to Gulf of Aden"),
    Chokepoint("Suez Canal", 29.8, 31.3, 32.2, 32.6, 0, "northbound", "southbound"),
    Chokepoint("Singapore Strait", 1.0, 1.5, 103.5, 104.3, 90, "eastbound", "westbound"),
    Chokepoint("Panama Canal", 8.8, 9.4, -79.95, -79.5, 330, "to Atlantic", "to Pacific"),
    Chokepoint("Cape of Good Hope", -36.5, -33.5, 17.5, 21.0, 90, "eastbound (to Indian Ocean)", "westbound (to Atlantic)"),
    Chokepoint("Strait of Gibraltar", 35.8, 36.2, -6.0, -5.3, 90, "into the Med", "out to Atlantic"),
    Chokepoint("Dover Strait", 50.8, 51.2, 1.2, 1.8, 45, "northeast", "southwest"),
)

# Watch regions around the chokepoints plus the routes between them; a
# whole-planet subscription is far more traffic than this needs.
WATCH_BOXES = [
    [[22.0, 47.0], [30.5, 60.0]],     # Persian Gulf + Gulf of Oman
    [[10.0, 32.0], [31.5, 52.0]],     # Red Sea, Gulf of Aden, Suez
    [[-1.0, 95.0], [7.0, 105.0]],     # Malacca + Singapore
    [[7.0, -81.0], [10.5, -78.5]],    # Panama
    [[-40.0, 10.0], [-28.0, 35.0]],   # Southern Africa / Cape route
    [[34.5, -10.0], [37.5, 0.0]],     # Gibraltar
    [[49.0, -2.0], [52.5, 4.0]],      # English Channel
]


def ship_category(ais_type: int | None) -> str:
    if ais_type is None:
        return "unknown"
    if 80 <= ais_type <= 89:
        return "tanker"
    if 70 <= ais_type <= 79:
        return "cargo"
    if 60 <= ais_type <= 69:
        return "passenger"
    if ais_type in (30,):
        return "fishing"
    if ais_type in (35, 55):
        return "military/law"
    return "other"


def _angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _in_box(box: list[list[float]], lat: float, lon: float) -> bool:
    (lat0, lon0), (lat1, lon1) = box
    return lat0 <= lat <= lat1 and lon0 <= lon <= lon1


def _watch_region(cp: Chokepoint) -> list[list[float]] | None:
    lat, lon = (cp.lat_min + cp.lat_max) / 2, (cp.lon_min + cp.lon_max) / 2
    return next((b for b in WATCH_BOXES if _in_box(b, lat, lon)), None)


def coverage_level(region_ships: int) -> str:
    """aisstream is fed by volunteer coastal receivers, so some regions
    (the Gulf, the Red Sea) barely report at all. Zero ships in a chokepoint
    only means "empty" if the surrounding region is reporting traffic -
    otherwise it means "nobody is listening there"."""
    if region_ships == 0:
        return "none"
    if region_ships < 10:
        return "sparse"
    return "ok"


def chokepoint_stats(ships: dict[int, dict]) -> list[dict]:
    stats = []
    for cp in CHOKEPOINTS:
        region = _watch_region(cp)
        region_ships = sum(1 for s in ships.values() if region and _in_box(region, s["lat"], s["lon"]))
        inside = [s for s in ships.values() if cp.contains(s["lat"], s["lon"])]
        moving = [s for s in inside if (s.get("sog") or 0) >= 1.0 and s.get("cog") is not None]
        toward_a = sum(1 for s in moving if _angle_diff(s["cog"], cp.bearing_a) < 90)
        by_cat: dict[str, int] = {}
        for s in inside:
            by_cat[s["category"]] = by_cat.get(s["category"], 0) + 1
        stats.append({
            "name": cp.name,
            "box": [cp.lat_min, cp.lon_min, cp.lat_max, cp.lon_max],
            "total": len(inside),
            "moving": len(moving),
            "stationary": len(inside) - len(moving),
            "directions": {cp.label_a: toward_a, cp.label_b: len(moving) - toward_a},
            "by_category": by_cat,
            "region_ships": region_ships,
            "coverage": coverage_level(region_ships),
        })
    return stats


class ShipTracker:
    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.ships: dict[int, dict] = {}
        self.static: dict[int, dict] = {}
        self.connected = False
        self.messages = 0
        self.last_message_at: float | None = None
        self.last_error: str | None = None
        self.history: deque = deque(maxlen=24 * 60 * 60 // SNAPSHOT_EVERY_S)
        self._load_history()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _load_history(self) -> None:
        if not HISTORY_FILE.exists():
            return
        cutoff = time.time() - 24 * 3600
        for line in HISTORY_FILE.read_text(encoding="utf-8").splitlines():
            entry = json.loads(line)
            if entry["t"] >= cutoff:
                self.history.append(entry)

    def handle(self, raw: str | bytes) -> None:
        msg = json.loads(raw)
        if "error" in msg:
            self.last_error = msg["error"]
            return
        meta = msg.get("MetaData", {})
        mmsi = meta.get("MMSI")
        if not mmsi:
            return
        self.messages += 1
        self.last_message_at = time.time()

        if msg.get("MessageType") == "ShipStaticData":
            data = msg["Message"]["ShipStaticData"]
            self.static[mmsi] = {
                "type": data.get("Type"),
                "destination": (data.get("Destination") or "").strip(),
            }
            if mmsi in self.ships:
                self.ships[mmsi].update(self._static_fields(mmsi))
            return

        report = msg.get("Message", {}).get("PositionReport")
        if not report:
            return
        lat, lon = report.get("Latitude"), report.get("Longitude")
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            return
        heading = report.get("TrueHeading")
        self.ships[mmsi] = {
            "mmsi": mmsi,
            "name": (meta.get("ShipName") or "").strip(),
            "lat": lat,
            "lon": lon,
            "sog": report.get("Sog"),
            "cog": report.get("Cog"),
            "heading": None if heading == 511 else heading,  # 511 = not available
            "seen": self.last_message_at,
            **self._static_fields(mmsi),
        }

    def _static_fields(self, mmsi: int) -> dict:
        s = self.static.get(mmsi, {})
        return {"category": ship_category(s.get("type")), "destination": s.get("destination", "")}

    def prune(self) -> None:
        cutoff = time.time() - STALE_AFTER_S
        for mmsi in [m for m, s in self.ships.items() if s["seen"] < cutoff]:
            del self.ships[mmsi]

    def snapshot_history(self) -> None:
        entry = {
            "t": time.time(),
            "counts": {
                c["name"]: {"total": c["total"], "moving": c["moving"], "region": c["region_ships"]}
                for c in chokepoint_stats(self.ships)
            },
        }
        self.history.append(entry)
        HISTORY_FILE.parent.mkdir(exist_ok=True)
        with HISTORY_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    async def run(self) -> None:
        backoff = 2
        while True:
            try:
                async with websockets.connect(AISSTREAM_URL, open_timeout=15) as ws:
                    await ws.send(json.dumps({
                        "APIKey": self.api_key,
                        "BoundingBoxes": WATCH_BOXES,
                        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
                    }))
                    self.connected, self.last_error, backoff = True, None, 2
                    async for raw in ws:
                        self.handle(raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network drops are routine on a long-lived socket
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("aisstream disconnected: %s", self.last_error)
            self.connected = False
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def maintain(self) -> None:
        while True:
            await asyncio.sleep(SNAPSHOT_EVERY_S)
            self.prune()
            if self.connected:
                self.snapshot_history()

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "connected": self.connected,
            "messages": self.messages,
            "tracked": len(self.ships),
            "last_message_at": self.last_message_at,
            "last_error": self.last_error,
        }

    def snapshot(self) -> dict:
        self.prune()
        return {
            "status": self.status(),
            "fields": ["mmsi", "name", "lat", "lon", "sog", "cog", "category", "destination"],
            "ships": [
                [s["mmsi"], s["name"], round(s["lat"], 4), round(s["lon"], 4),
                 s["sog"], s["cog"], s["category"], s["destination"]]
                for s in self.ships.values()
            ],
            "chokepoints": chokepoint_stats(self.ships),
            "history": list(self.history),
        }
