import asyncio
import re

import httpx

from app.live import youtube


def test_streams_have_valid_ids_and_coordinates():
    ids = [s[0] for s in youtube.STREAMS]
    assert len(ids) == len(set(ids))
    for vid, name, place, lat, lon in youtube.STREAMS:
        assert re.fullmatch(r"[\w-]{11}", vid), vid
        assert -90 <= lat <= 90 and -180 <= lon <= 180, name


def test_dead_and_unembeddable_streams_are_dropped(monkeypatch):
    first, second, third = youtube.STREAMS[:3]
    monkeypatch.setattr(youtube, "STREAMS", [first, second, third])

    def handler(request: httpx.Request) -> httpx.Response:
        url = request.url.params["url"]
        if second[0] in url:
            return httpx.Response(404)  # stream ended / video removed
        if third[0] in url:
            return httpx.Response(401)  # owner disabled embedding
        return httpx.Response(200, json={"author_name": "EarthCam"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await youtube.live_streams.__wrapped__(client)

    result = asyncio.run(run())
    assert result["curated"] == 3
    assert [s["id"] for s in result["streams"]] == [first[0]]
    assert result["streams"][0]["channel"] == "EarthCam"
