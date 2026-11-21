"""Public camera feeds - official traffic and tourism cameras only.

  - TfL JamCams: ~800 live London traffic cameras (still + ~10s clip)
  - Caltrans: California highway cameras (still + live HLS stream)
  - Windy Webcams: worldwide webcams, fetched per area on demand (free key)

Sites that stream unsecured private cameras (Insecam and the like) are
deliberately not used: those are people's homes and shops with default
passwords, and viewing them is illegal in most jurisdictions.
"""

import asyncio

import httpx

from .cache import ttl_cache

TFL_URL = "https://api.tfl.gov.uk/Place/Type/JamCam"
CALTRANS_URL = "https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02d}.json"
CALTRANS_DISTRICTS = range(1, 13)
WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams"

# Compact rows: [id, source, name, lat, lon, image_url, video_url, video_kind]
FIELDS = ["id", "source", "name", "lat", "lon", "image", "video", "video_kind"]


def parse_tfl(places: list[dict]) -> list[list]:
    cams = []
    for p in places:
        props = {a["key"]: a["value"] for a in p.get("additionalProperties", [])}
        if props.get("available") != "true" or not props.get("imageUrl"):
            continue
        name = p.get("commonName", "")
        if props.get("view"):
            name = f"{name} ({props['view']})"
        cams.append([p["id"], "TfL", name, round(p["lat"], 5), round(p["lon"], 5),
                     props["imageUrl"], props.get("videoUrl"), "mp4" if props.get("videoUrl") else None])
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
        cams.append([f"caltrans:{loc.get('district')}:{c.get('index')}", "Caltrans", name, round(lat, 5), round(lon, 5),
                     image, stream if has_stream else None, "hls" if has_stream else None])
    return cams


async def _caltrans_district(d: int, client: httpx.AsyncClient) -> list[list]:
    try:
        resp = await client.get(CALTRANS_URL.format(d=d), timeout=30.0)
        resp.raise_for_status()
        return parse_caltrans(resp.json().get("data", []))
    except (httpx.HTTPError, ValueError):
        return []  # one district down shouldn't blank the whole state


@ttl_cache(3600)
async def fixed_cameras(client: httpx.AsyncClient) -> dict:
    tfl_resp, *districts = await asyncio.gather(
        client.get(TFL_URL, timeout=30.0),
        *(_caltrans_district(d, client) for d in CALTRANS_DISTRICTS),
        return_exceptions=True,
    )
    tfl = []
    if isinstance(tfl_resp, httpx.Response) and tfl_resp.status_code == 200:
        tfl = parse_tfl(tfl_resp.json())
    caltrans = [c for d in districts if isinstance(d, list) for c in d]
    return {
        "fields": FIELDS,
        "counts": {"TfL": len(tfl), "Caltrans": len(caltrans)},
        "cameras": tfl + caltrans,
    }


def parse_windy(payload: dict) -> list[dict]:
    cams = []
    for w in payload.get("webcams", []):
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


# Free-tier image URLs carry a token that expires after ~10 minutes, so the
# cache has to stay under that.
@ttl_cache(8 * 60)
async def windy_nearby(lat: float, lon: float, api_key: str, client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(
        WINDY_URL,
        params={
            "nearby": f"{lat},{lon},150",
            "limit": 50,
            "include": "location,images,player,urls",
        },
        headers={"x-windy-api-key": api_key},
        timeout=20.0,
    )
    resp.raise_for_status()
    return parse_windy(resp.json())
