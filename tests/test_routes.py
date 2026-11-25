import asyncio

import httpx

from app.live import routes

# Trimmed from the real adsbdb answer for IndiGo 7251
IGO7251 = {"response": {"flightroute": {
    "callsign": "IGO7251", "callsign_icao": "IGO7251", "callsign_iata": "6E7251",
    "airline": {"name": "IndiGo Airlines", "icao": "IGO", "iata": "6E"},
    "origin": {"iata_code": "IXE", "icao_code": "VOML", "latitude": 12.9613, "longitude": 74.8901,
               "municipality": "Mangalore", "name": "Mangalore International Airport", "country_name": "India"},
    "destination": {"iata_code": "BLR", "icao_code": "VOBL", "latitude": 13.1979, "longitude": 77.7063,
                    "municipality": "Bangalore", "name": "Kempegowda International Airport", "country_name": "India"},
}}}


def test_parse_route():
    r = routes.parse_route(IGO7251)
    assert r["flight_number"] == "6E7251" and r["airline"] == "IndiGo Airlines"
    assert (r["origin"]["iata"], r["origin"]["city"]) == ("IXE", "Mangalore")
    assert (r["destination"]["iata"], r["destination"]["lat"]) == ("BLR", 13.1979)


def test_parse_route_rejects_unknown_and_incomplete():
    assert routes.parse_route({"response": "unknown callsign"}) is None
    broken = {"response": {"flightroute": {**IGO7251["response"]["flightroute"], "destination": None}}}
    assert routes.parse_route(broken) is None


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_unknown_callsign_is_none_not_an_error():
    client = _client(lambda req: httpx.Response(404, json={"response": "unknown callsign"}))
    assert asyncio.run(routes.lookup.__wrapped__("ZZZ999", client)) is None


def test_upstream_failure_raises_so_the_api_returns_502():
    client = _client(lambda req: httpx.Response(503))
    try:
        asyncio.run(routes.lookup.__wrapped__("IGO7251", client))
    except httpx.HTTPStatusError:
        return
    raise AssertionError("expected HTTPStatusError")
