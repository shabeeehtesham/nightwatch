"""Public camera feeds - official traffic and tourism cameras only.

Government traffic cameras (no key):
  - TfL JamCams, London (still + ~10s clip)
  - Caltrans, California (still + live HLS stream)
  - DriveBC, British Columbia
  - Fintraffic weathercams, Finland
  - Waka Kotahi NZTA, New Zealand
  - Transport Department, Hong Kong
  - LTA, Singapore
Windy Webcams (free key): ~1,000 worldwide webcams for the globe view, plus
dense per-area results once you zoom in.

Sites that stream unsecured private cameras (Insecam and the like) are
deliberately not used: those are people's homes and shops with default
passwords, and viewing them is illegal in most jurisdictions.
"""

import asyncio
import xml.etree.ElementTree as ET

import httpx

from .cache import ttl_cache

TFL_URL = "https://api.tfl.gov.uk/Place/Type/JamCam"
CALTRANS_URL = "https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02d}.json"
CALTRANS_DISTRICTS = range(1, 13)
DRIVEBC_URL = "https://www.drivebc.ca/api/webcams/"
FINLAND_URL = "https://tie.digitraffic.fi/api/weathercam/v1/stations"
NZTA_URL = "https://trafficnz.info/service/traffic/rest/4/cameras/all"
HONGKONG_URL = "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml"
SINGAPORE_URL = "https://api.data.gov.sg/v1/transport/traffic-images"
WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams"
WINDY_CLUSTERS_URL = "https://api.windy.com/webcams/api/v3/map/clusters"

# Compact rows: [id, source, name, lat, lon, image_url, video_url, video_kind]
FIELDS = ["id", "source", "name", "lat", "lon", "image", "video", "video_kind"]


def _row(cam_id, source, name, lat, lon, image, video=None, video_kind=None) -> list:
    return [cam_id, source, name, round(float(lat), 5), round(float(lon), 5), image, video, video_kind]


def parse_tfl(places: list[dict]) -> list[list]:
    cams = []
    for p in places:
        props = {a["key"]: a["value"] for a in p.get("additionalProperties", [])}
        if props.get("available") != "true" or not props.get("imageUrl"):
            continue
        name = p.get("commonName", "")
        if props.get("view"):
            name = f"{name} ({props['view']})"
        video = props.get("videoUrl")
        cams.append(_row(p["id"], "TfL", name, p["lat"], p["lon"], props["imageUrl"], video, "mp4" if video else None))
    return cams


def parse_caltrans(records: list[dict]) -> list[list]:
    cams = []
    for r in records:
        c = r.get("cctv", {})
        loc, img = c.get("location", {}), c.get("imageData", {})
        image = img.get("static", {}).get("currentImageURL")
        if c.get("inService") != "true" or not image:
            continue
        try:
            lat, lon = float(loc["latitude"]), float(loc["longitude"])
        except (KeyError, ValueError):
            continue
        stream = img.get("streamingVideoURL") or ""
        has_stream = stream.startswith("https://")
        name = loc.get("locationName", "")
        if loc.get("nearbyPlace"):
            name = f"{name} - {loc['nearbyPlace']}"
        cams.append(_row(f"caltrans:{loc.get('district')}:{c.get('index')}", "Caltrans", name, lat, lon,
                         image, stream if has_stream else None, "hls" if has_stream else None))
    return cams


def parse_drivebc(webcams: list[dict]) -> list[list]:
    cams = []
    for w in webcams:
        coords = (w.get("location") or {}).get("coordinates")
        path = (w.get("links") or {}).get("imageDisplay")
        if not w.get("is_on") or w.get("marked_stale") or not coords or not path:
            continue
        lon, lat = coords[0], coords[1]
        cams.append(_row(f"drivebc:{w['id']}", "DriveBC", w.get("caption") or w.get("name", ""), lat, lon,
                         f"https://www.drivebc.ca/images/{w['id']}.jpg"))
    return cams


def parse_finland(geojson: dict) -> list[list]:
    cams = []
    for f in geojson.get("features", []):
        p = f.get("properties", {})
        presets = [x["id"] for x in p.get("presets", []) if x.get("inCollection")]
        if p.get("collectionStatus") != "GATHERING" or not presets:
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        name = p.get("name", "").replace("_", " ")
        cams.append(_row(f"fi:{p['id']}", "Fintraffic", name, lat, lon, f"https://weathercam.digitraffic.fi/{presets[0]}.jpg"))
    return cams


def parse_nzta(payload: dict) -> list[list]:
    cams = []
    for c in payload.get("response", {}).get("camera", []):
        if c.get("offline") or c.get("underMaintenance") or not c.get("imageUrl"):
            continue
        name = c.get("name", "").strip()
        if c.get("description"):
            name = f"{name} - {c['description']}"
        cams.append(_row(f"nz:{c['id']}", "NZTA", name, c["latitude"], c["longitude"],
                         f"https://trafficnz.info{c['imageUrl']}"))
    return cams


def parse_hongkong(xml_text: str) -> list[list]:
    cams = []
    for img in ET.fromstring(xml_text).iter("image"):
        f = {child.tag: (child.text or "").strip() for child in img}
        if not f.get("url") or not f.get("latitude"):
            continue
        cams.append(_row(f"hk:{f['key']}", "HK Transport Dept", f.get("description", ""), f["latitude"], f["longitude"], f["url"]))
    return cams


def parse_singapore(payload: dict) -> list[list]:
    items = payload.get("items") or [{}]
    return [
        _row(f"sg:{c['camera_id']}", "LTA Singapore", f"Traffic camera {c['camera_id']}",
             c["location"]["latitude"], c["location"]["longitude"], c["image"])
        for c in items[0].get("cameras", [])
    ]


async def _fetch(client: httpx.AsyncClient, url: str, parse, *, as_text=False, **kwargs) -> list[list]:
    """One source down (they're free public feeds) shouldn't blank the layer."""
    try:
        resp = await client.get(url, timeout=30.0, follow_redirects=True, **kwargs)
        resp.raise_for_status()
        return parse(resp.text if as_text else resp.json())
    except (httpx.HTTPError, ValueError, ET.ParseError, KeyError, TypeError):
        return []


async def _caltrans(client: httpx.AsyncClient) -> list[list]:
    districts = await asyncio.gather(*(
        _fetch(client, CALTRANS_URL.format(d=d), lambda j: parse_caltrans(j.get("data", [])))
        for d in CALTRANS_DISTRICTS
    ))
    return [c for d in districts for c in d]


@ttl_cache(3600)
async def fixed_cameras(client: httpx.AsyncClient) -> dict:
    sources = {
        "TfL": _fetch(client, TFL_URL, parse_tfl),
        "Caltrans": _caltrans(client),
        "DriveBC": _fetch(client, DRIVEBC_URL, parse_drivebc),
        # Digitraffic rejects requests that don't accept gzip (HTTP 406)
        "Fintraffic": _fetch(client, FINLAND_URL, parse_finland, headers={"Accept-Encoding": "gzip"}),
        "NZTA": _fetch(client, NZTA_URL, parse_nzta, headers={"Accept": "application/json"}),
        "HK Transport Dept": _fetch(client, HONGKONG_URL, parse_hongkong, as_text=True),
        "LTA Singapore": _fetch(client, SINGAPORE_URL, parse_singapore),
    }
    results = dict(zip(sources, await asyncio.gather(*sources.values())))
    return {
        "fields": FIELDS,
        "counts": {name: len(rows) for name, rows in results.items()},
        "cameras": [row for rows in results.values() for row in rows],
    }


def parse_windy(payload: dict | list) -> list[dict]:
    webcams = payload if isinstance(payload, list) else payload.get("webcams", [])
    cams = []
    for w in webcams:
        loc = w.get("location") or {}
        if loc.get("latitude") is None or w.get("status") != "active":
            continue
        current = (w.get("images") or {}).get("current") or {}
        player = w.get("player") or {}
        cams.append({
            "id": f"windy:{w['webcamId']}",
            "source": "Windy",
            "name": w.get("title", ""),
            "lat": loc["latitude"],
            "lon": loc["longitude"],
            "place": ", ".join(x for x in (loc.get("city"), loc.get("country")) if x),
            # Windy's terms: use their image URLs unmodified, link every image back to them
            "image": current.get("preview") or current.get("thumbnail") or current.get("icon"),
            "thumb": current.get("thumbnail") or current.get("icon"),
            "player": player.get("live") or player.get("day"),
            "detail_url": (w.get("urls") or {}).get("detail"),
            "updated": w.get("lastUpdatedOn"),
        })
    return cams


# Free-tier image URLs carry a token that expires after ~10 minutes, so
# anything that includes images has to be cached for less than that.
IMAGE_TTL = 8 * 60


@ttl_cache(IMAGE_TTL)
async def windy_nearby(lat: float, lon: float, api_key: str, client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(
        WINDY_URL,
        params={"nearby": f"{lat},{lon},150", "limit": 50, "include": "location,images,player,urls"},
        headers={"x-windy-api-key": api_key},
        timeout=20.0,
    )
    resp.raise_for_status()
    return parse_windy(resp.json())


# Windy's map/clusters endpoint returns webcams spread evenly over a box,
# but at zoom 5 a box may span at most 11.25 deg of latitude and 22.5 deg of
# longitude - so the inhabited world is a 12 x 16 grid (192 calls, ~5s).
WORLD_ZOOM = 5
LAT_STEP, LON_STEP = 11.25, 22.5
WORLD_LATS = [i * LAT_STEP for i in range(-5, 7)]  # -56.25 .. 78.75
WORLD_LONS = [i * LON_STEP for i in range(-8, 8)]


@ttl_cache(6 * 3600)
async def windy_world(api_key: str, client: httpx.AsyncClient) -> list[list]:
    """Locations only (no images): those don't expire, so this can be cached
    for hours. Images are fetched per camera, on demand, via windy_details."""
    sem = asyncio.Semaphore(8)

    async def tile(south: float, west: float) -> list[dict]:
        async with sem:
            try:
                resp = await client.get(
                    WINDY_CLUSTERS_URL,
                    params={"northLat": south + LAT_STEP, "southLat": south, "eastLon": west + LON_STEP,
                            "westLon": west, "zoom": WORLD_ZOOM, "include": "location"},
                    headers={"x-windy-api-key": api_key},
                    timeout=20.0,
                )
                resp.raise_for_status()
                return resp.json()
            except (httpx.HTTPError, ValueError):
                return []

    tiles = await asyncio.gather(*(tile(s, w) for s in WORLD_LATS for w in WORLD_LONS))
    seen, rows = set(), []
    for w in (w for t in tiles for w in t):
        loc = w.get("location") or {}
        if w["webcamId"] in seen or loc.get("latitude") is None:
            continue
        seen.add(w["webcamId"])
        rows.append(_row(f"windy:{w['webcamId']}", "Windy", w.get("title", ""), loc["latitude"], loc["longitude"], None))
    return rows


async def windy_details(ids: list[int], api_key: str, client: httpx.AsyncClient) -> list[dict]:
    """Fresh images/player links for up to 50 webcams in one call."""
    resp = await client.get(
        WINDY_URL,
        params={"webcamIds": ",".join(map(str, ids[:50])), "limit": 50, "include": "location,images,player,urls"},
        headers={"x-windy-api-key": api_key},
        timeout=20.0,
    )
    resp.raise_for_status()
    return parse_windy(resp.json())
