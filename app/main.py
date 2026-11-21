import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .live import cables, cameras, earthquakes, flights, incidents, news, satellites
from .live.ships import ShipTracker

# Explicit path: load_dotenv()'s call-stack search misses the file inside
# uvicorn's --reload worker process.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

STATIC_DIR = Path(__file__).parent / "static"
USER_AGENT = "nightwatch-osint/0.1 (+https://github.com/shabeeehtesham/nightwatch)"


async def _warm(coro):
    try:
        await coro
    except httpx.HTTPError:
        pass  # the real request will retry and report it


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=20.0)
    app.state.ships = ShipTracker(os.environ.get("AISSTREAM_API_KEY"))
    # Caltrans spreads its cameras over 12 district files (~16s cold); warm
    # the cache now so the first page load doesn't wait on it.
    tasks = [asyncio.create_task(_warm(cameras.fixed_cameras(app.state.http)))]
    if app.state.ships.enabled:
        tasks += [asyncio.create_task(app.state.ships.run()), asyncio.create_task(app.state.ships.maintain())]
    yield
    for t in tasks:
        t.cancel()
    await app.state.http.aclose()


app = FastAPI(title="NIGHTWATCH", lifespan=lifespan)


async def _upstream(coro):
    """Free public feeds go down; surface that as a 502 the UI can show
    per-layer, instead of a 500 that looks like our bug."""
    try:
        return await coro
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"upstream source unavailable: {type(exc).__name__}")


@app.get("/api/live/flights")
async def live_flights(request: Request):
    return await _upstream(flights.snapshot(request.app.state.http))


@app.get("/api/live/earthquakes")
async def live_earthquakes(request: Request):
    return await _upstream(earthquakes.recent(request.app.state.http))


@app.get("/api/live/satellites")
async def live_satellites(request: Request):
    return await _upstream(satellites.elements(request.app.state.http))


@app.get("/api/live/cables")
async def live_cables(request: Request):
    return await _upstream(cables.routes(request.app.state.http))


@app.get("/api/live/news")
async def live_news(request: Request):
    return await _upstream(news.headlines(request.app.state.http))


@app.get("/api/live/incidents")
async def live_incidents(request: Request):
    return await _upstream(incidents.reported(request.app.state.http))


@app.get("/api/live/ships")
async def live_ships(request: Request):
    return request.app.state.ships.snapshot()


@app.get("/api/live/cameras")
async def live_cameras(request: Request):
    data = await _upstream(cameras.fixed_cameras(request.app.state.http))
    return {**data, "windy_enabled": bool(os.environ.get("WINDY_API_KEY"))}


@app.get("/api/live/webcams")
async def live_webcams(request: Request, lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    key = os.environ.get("WINDY_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="WINDY_API_KEY not set")
    # Snap to a 1-degree grid so nearby viewports share one cached Windy call
    return await _upstream(cameras.windy_nearby(round(lat), round(lon), key, request.app.state.http))


@app.get("/api/health")
async def health(request: Request):
    return {
        "ok": True,
        "ships": request.app.state.ships.status(),
        "windy_enabled": bool(os.environ.get("WINDY_API_KEY")),
    }


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
