import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .live import cables, earthquakes, flights, incidents, news, satellites
from .live.ships import ShipTracker

load_dotenv()

STATIC_DIR = Path(__file__).parent / "static"
USER_AGENT = "nightwatch-osint/0.1 (+https://github.com/shabeeehtesham/nightwatch)"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=20.0)
    app.state.ships = ShipTracker(os.environ.get("AISSTREAM_API_KEY"))
    tasks = []
    if app.state.ships.enabled:
        tasks = [asyncio.create_task(app.state.ships.run()), asyncio.create_task(app.state.ships.maintain())]
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


@app.get("/api/health")
async def health(request: Request):
    return {"ok": True, "ships": request.app.state.ships.status()}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
