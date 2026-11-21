"""Domain registration data via RDAP - the JSON successor to WHOIS, so no
fragile per-registrar text parsing."""

import httpx

RDAP_URL = "https://rdap.org/domain/{domain}"


def _vcard_name(entity: dict) -> str | None:
    vcard = entity.get("vcardArray")
    if not vcard or len(vcard) < 2:
        return None
    for field in vcard[1]:
        if field[0] == "fn":
            return field[3] or None
    return None


def parse_rdap(payload: dict) -> dict:
    events = {e.get("eventAction"): e.get("eventDate") for e in payload.get("events", [])}

    registrar = None
    for entity in payload.get("entities", []):
        if "registrar" in entity.get("roles", []):
            registrar = _vcard_name(entity) or entity.get("handle")
            break

    return {
        "registrar": registrar,
        "registered": events.get("registration"),
        "expires": events.get("expiration"),
        "last_changed": events.get("last changed"),
        "status": payload.get("status", []),
        "nameservers": sorted(ns.get("ldhName", "").lower() for ns in payload.get("nameservers", [])),
        "dnssec": payload.get("secureDNS", {}).get("delegationSigned"),
    }


async def lookup(domain: str, client: httpx.AsyncClient) -> dict:
    resp = await client.get(RDAP_URL.format(domain=domain), follow_redirects=True)
    resp.raise_for_status()
    return parse_rdap(resp.json())
