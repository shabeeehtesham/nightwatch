"""Site history from the Internet Archive's CDX API - how long the domain
has had a live site, and how actively it's been captured."""

import httpx

CDX_URL = "https://web.archive.org/cdx/search/cdx"


def parse_cdx(rows: list[list[str]]) -> dict:
    # first row is the header: ["timestamp"]
    timestamps = [row[0] for row in rows[1:]]
    if not timestamps:
        return {"first_snapshot": None, "last_snapshot": None, "years_active": [], "snapshot_years": 0}

    years = sorted({ts[:4] for ts in timestamps})
    return {
        "first_snapshot": _fmt(timestamps[0]),
        "last_snapshot": _fmt(timestamps[-1]),
        "years_active": years,
        "snapshot_years": len(years),
    }


def _fmt(ts: str) -> str:
    return f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"


async def lookup(domain: str, client: httpx.AsyncClient) -> dict:
    params = {
        "url": domain,
        "output": "json",
        "fl": "timestamp",
        "collapse": "timestamp:6",  # at most one capture per month
        "filter": "statuscode:200",
    }
    resp = await client.get(CDX_URL, params=params, timeout=30.0)
    resp.raise_for_status()
    return parse_cdx(resp.json() if resp.text.strip() else [])
