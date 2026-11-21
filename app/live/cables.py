import httpx

from .cache import ttl_cache

CABLES_URL = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json"


@ttl_cache(24 * 3600)
async def routes(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(CABLES_URL, timeout=30.0)
    resp.raise_for_status()
    paths = []
    for f in resp.json().get("features", []):
        geom = f.get("geometry") or {}
        segments = geom.get("coordinates", [])
        if geom.get("type") == "LineString":
            segments = [segments]
        props = f.get("properties", {})
        for seg in segments:
            # [lon, lat] -> [lat, lon], rounded: 750KB of GeoJSON down to a fraction
            paths.append({
                "name": props.get("name"),
                "color": props.get("color"),
                "coords": [[round(lat, 2), round(lon, 2)] for lon, lat in seg],
            })
    return paths
