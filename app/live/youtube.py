"""Curated 24/7 YouTube live cams, pinned to the place they show.

Each entry was found with YouTube's live filter and verified as live and
embeddable. Live video IDs change when a channel restarts its stream, so at
runtime every ID is re-checked through YouTube's official oEmbed endpoint
(404 = gone, 401 = embedding disabled) and dead ones are dropped rather
than shown as a broken player. Playback uses the official embed only.
"""

import asyncio

import httpx

from .cache import ttl_cache

OEMBED_URL = "https://www.youtube.com/oembed"

# (video_id, name, place, lat, lon) - coordinates are the subject in view
STREAMS = [
    ("ZxCeWQ3Lcig", "Times Square North", "New York, US", 40.7580, -73.9855),
    ("dfVK7ld38Ys", "Shibuya Scramble Crossing", "Tokyo, Japan", 35.6595, 139.7005),
    ("nu6NE55_X7A", "Tokyo Tower", "Tokyo, Japan", 35.6586, 139.7454),
    ("gFRtAAmiFbE", "Kabukicho, Shinjuku", "Tokyo, Japan", 35.6938, 139.7034),
    ("cvrTVNfsgCM", "Mount Fuji from Fumotoppara", "Shizuoka, Japan", 35.4006, 138.5707),
    ("a1mcaV3Sf9U", "Venice rolling cam", "Venice, Italy", 45.4340, 12.3388),
    ("03pYP2Nmreo", "St. Peter's Square", "Vatican City", 41.9022, 12.4539),
    ("zMCea32gpmg", "Abbey Road Crossing", "London, UK", 51.5320, -0.1778),
    ("MXmzsjABC-U", "London Bridge & River Thames", "London, UK", 51.5079, -0.0877),
    ("3nyPER2kzqk", "Temple Bar", "Dublin, Ireland", 53.3455, -6.2643),
    ("Gd9d4q6WvUY", "Dam Square", "Amsterdam, Netherlands", 52.3731, 4.8926),
    ("M09NaBVPjAI", "Amazonehaven, Port of Rotterdam", "Rotterdam, Netherlands", 51.9500, 4.0400),
    ("kvYMIaXclIE", "Prague city view", "Prague, Czechia", 50.0870, 14.4210),
    ("QI-PPEW2Bgc", "Paris skyline with the Eiffel Tower", "Paris, France", 48.8584, 2.2945),
    ("nefnkjc1yVs", "Barcelona skyline", "Barcelona, Spain", 41.4180, 2.1700),
    ("tKIgNtEgLN0", "Lisbon", "Lisbon, Portugal", 38.7139, -9.1394),
    ("QIt1FaDMnQc", "Lucerne", "Lucerne, Switzerland", 47.0502, 8.3093),
    ("CcnlJI_UXyM", "Arillas beach", "Corfu, Greece", 39.7500, 19.6500),
    ("upOiG0CMlnw", "Primosten panorama", "Primosten, Croatia", 43.5860, 15.9260),
    ("xKaWhDoufbk", "Galata & Maiden's Tower, Bosphorus", "Istanbul, Turkey", 41.0211, 29.0041),
    ("77akujLn4k8", "Western Wall", "Jerusalem", 31.7767, 35.2345),
    ("8be64XYOdhQ", "Masjid al-Haram", "Mecca, Saudi Arabia", 21.4225, 39.8262),
    ("4Zu64CmAjMo", "Sea Point & Lion's Head", "Cape Town, South Africa", -33.9150, 18.3900),
    ("Z8NTLkEFZjg", "Tsim Sha Tsui", "Hong Kong", 22.2946, 114.1720),
    ("JE5E5p8ACCQ", "Singapore port, Tanjong Pagar", "Singapore", 1.2650, 103.8400),
    ("UemFRPrl1hk", "Soi 11, Sukhumvit Road", "Bangkok, Thailand", 13.7440, 100.5560),
    ("vk5BHoDxXf0", "Han River skyline", "Seoul, South Korea", 37.5170, 126.9900),
    ("5uZa3-RMFos", "Sydney Harbour", "Sydney, Australia", -33.8523, 151.2108),
    ("HggWKlZv9yk", "Kilauea volcano, Halemaumau crater (USGS)", "Hawaii, US", 19.4050, -155.2810),
    ("46UxBBAzSaY", "Golden Gate Bridge", "San Francisco, US", 37.8199, -122.4783),
    ("1EiC9bvVGnk", "Town Square", "Jackson Hole, US", 43.4799, -110.7624),
    ("KTJ8Hj_tmk4", "Downtown Chicago", "Chicago, US", 41.8819, -87.6278),
    ("xqdukYhcGEU", "French Quarter street view", "New Orleans, US", 29.9584, -90.0651),
    ("ICva1RPK6Do", "Lower Broadway", "Nashville, US", 36.1612, -86.7775),
    ("vvdy20Ho7ac", "Southernmost Point buoy", "Key West, US", 24.5465, -81.7975),
    ("qx7gry390YA", "Niagara Falls", "Niagara Falls, US/Canada", 43.0799, -79.0747),
    ("bzfCbXAjk4s", "Panama City", "Panama City, Panama", 8.9824, -79.5199),
]


async def _check(video_id: str, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict | None:
    async with sem:
        try:
            resp = await client.get(
                OEMBED_URL,
                params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
                timeout=15.0,
            )
        except httpx.HTTPError:
            return {}  # network blip: keep the stream rather than hide a working one
    if resp.status_code != 200:
        return None
    return resp.json()


@ttl_cache(6 * 3600)
async def live_streams(client: httpx.AsyncClient) -> dict:
    sem = asyncio.Semaphore(8)
    checks = await asyncio.gather(*(_check(s[0], client, sem) for s in STREAMS))
    streams = [
        {"id": vid, "name": name, "place": place, "lat": lat, "lon": lon, "channel": (meta or {}).get("author_name", "")}
        for (vid, name, place, lat, lon), meta in zip(STREAMS, checks)
        if meta is not None
    ]
    return {"curated": len(STREAMS), "available": len(streams), "streams": streams}
