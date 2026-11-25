import asyncio
import math

import httpx

from app.live import flights

# Trimmed from a real adsb.fi response
BAW1 = {"hex": "406a02", "flight": "BAW1    ", "r": "G-EUYS", "t": "A320",
        "alt_baro": 1000, "gs": 122.0, "track": 89.06, "lat": 55.538821, "lon": -4.688501}


def test_parse_adsb_converts_feet_and_knots():
    assert flights.parse_adsb(BAW1) == ["406a02", "BAW1", None, -4.689, 55.539, 305, 63, 89, "G-EUYS", "A320"]


def test_parse_adsb_skips_grounded_and_unpositioned():
    assert flights.parse_adsb({**BAW1, "alt_baro": "ground"}) is None
    assert flights.parse_adsb({"hex": "abcdef", "alt_baro": 30000}) is None


def test_parse_adsb_strips_non_icao_marker():
    # readsb prefixes TIS-B / non-ICAO addresses with "~"
    assert flights.parse_adsb({**BAW1, "hex": "~2c1234"})[0] == "2c1234"


def test_sweep_circles_overlap():
    # 250 nm circles must be closer than one diameter apart, or the grid has holes
    radius_deg = flights.RADIUS_NM * 1.852 / 111.0
    points = flights.sweep_points()
    assert 100 < len(points) < 200  # ~1 req/s: a sweep should take a few minutes, not ten
    lats = sorted({lat for lat, _ in points if -125 < _ < -67 and lat > 20})
    assert all(b - a < 2 * radius_deg for a, b in zip(lats, lats[1:]))


def _feed(handler) -> flights.FlightFeed:
    feed = flights.FlightFeed(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    feed.adsb.MIN_GAP_S = 0.001  # tiny, but still yields so the sweep can't hog the loop
    return feed


def test_falls_back_to_adsbfi_when_opensky_is_unreachable():
    def handler(request: httpx.Request):
        if "opensky" in request.url.host:
            raise httpx.ConnectTimeout("blocked", request=request)
        return httpx.Response(200, json={"aircraft": [BAW1]})

    async def run():
        feed = _feed(handler)
        feed.points = [(51.5, 0.0)]
        first = await feed.snapshot()
        await asyncio.sleep(0.05)  # let one sweep pass run
        second = await feed.snapshot()
        feed._sweep_task.cancel()
        return first, second, feed

    first, second, feed = asyncio.run(run())
    assert first["source"] == "adsb.fi" and first["coverage"] == "regional sweep"
    assert second["count"] == 1 and second["flights"][0][1] == "BAW1"
    assert feed.opensky_error == "ConnectTimeout"


def test_search_by_callsign_then_registration():
    asked = []

    def handler(request: httpx.Request):
        asked.append(request.url.path)
        if "/callsign/" in request.url.path:
            return httpx.Response(200, json={"ac": []})
        return httpx.Response(200, json={"ac": [BAW1]})

    results = asyncio.run(_feed(handler).find("geuys"))
    assert [r[8] for r in results] == ["G-EUYS"]
    assert asked == ["/api/v2/callsign/GEUYS", "/api/v2/registration/GEUYS"]


def test_hex_lookup_goes_first():
    asked = []

    def handler(request: httpx.Request):
        asked.append(request.url.path)
        return httpx.Response(200, json={"ac": [BAW1]})

    asyncio.run(_feed(handler).find("406A02"))
    assert asked == ["/api/v2/hex/406a02"]


def test_search_falls_back_to_local_snapshot():
    def handler(request: httpx.Request):
        raise httpx.ConnectError("down", request=request)

    feed = _feed(handler)
    feed._opensky_rows = [["abc123", "UAE123", "UAE", 55.1, 25.2, 11000, 240, 90, None, None]]
    assert asyncio.run(feed.find("uae123"))[0][0] == "abc123"
    assert math.isclose(asyncio.run(feed.position("abc123"))[4], 25.2)
