import httpx

from .cache import ttl_cache

USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"


@ttl_cache(300)
async def recent(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(USGS_URL, timeout=20.0)
    resp.raise_for_status()
    quakes = []
    for f in resp.json().get("features", []):
        p = f["properties"]
        lon, lat, depth = f["geometry"]["coordinates"]
        quakes.append({
            "lat": lat,
            "lon": lon,
            "depth_km": depth,
            "mag": p.get("mag"),
            "place": p.get("place"),
            "time": p.get("time"),
            "tsunami": bool(p.get("tsunami")),
            "url": p.get("url"),
        })
    return sorted(quakes, key=lambda q: q["mag"] or 0, reverse=True)
