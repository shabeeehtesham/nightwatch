"""Headline ticker from established international outlets' own RSS feeds -
no aggregator in between, every item links straight to the publisher."""

import asyncio
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime

import httpx

from .cache import ttl_cache

FEEDS = {
    "BBC News": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "DW": "https://rss.dw.com/rdf/rss-en-world",
    "France 24": "https://www.france24.com/en/rss",
    "The Guardian": "https://www.theguardian.com/world/rss",
    "NPR": "https://feeds.npr.org/1004/rss.xml",
}


def parse_feed(outlet: str, xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    # RSS 2.0 <item> and RSS 1.0/RDF <item> (namespaced) both end in "item"
    for item in root.iter():
        if not item.tag.endswith("item"):
            continue
        fields = {child.tag.rsplit("}", 1)[-1]: (child.text or "").strip() for child in item}
        if fields.get("title") and fields.get("link"):
            items.append({
                "outlet": outlet,
                "title": fields["title"],
                "url": fields["link"],
                "published": _parse_date(fields.get("pubDate"), fields.get("date")),
            })
    return items


def _parse_date(rfc822: str | None, iso: str | None) -> float | None:
    # RSS 2.0 uses RFC 822 <pubDate>, RDF feeds (DW) use ISO 8601 <dc:date>
    try:
        if rfc822:
            return parsedate_to_datetime(rfc822).timestamp()
        if iso:
            return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        pass
    return None


async def _fetch(outlet: str, url: str, client: httpx.AsyncClient) -> list[dict]:
    try:
        resp = await client.get(url, timeout=15.0, follow_redirects=True)
        resp.raise_for_status()
        return parse_feed(outlet, resp.text)
    except (httpx.HTTPError, ET.ParseError):
        return []


@ttl_cache(300)
async def headlines(client: httpx.AsyncClient) -> dict:
    results = await asyncio.gather(*(_fetch(o, u, client) for o, u in FEEDS.items()))
    items = [i for feed in results for i in feed]
    items.sort(key=lambda i: i["published"] or 0, reverse=True)
    return {
        "outlets_ok": [o for o, feed in zip(FEEDS, results) if feed],
        "outlets_failed": [o for o, feed in zip(FEEDS, results) if not feed],
        "items": items[:80],
    }
