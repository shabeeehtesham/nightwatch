"""Subdomain discovery from Certificate Transparency logs (crt.sh).

Every publicly trusted TLS cert gets logged, so this surfaces subdomains
(staging., vpn., internal-tool.) without sending a single packet to the
target - the most useful passive recon source there is.
"""

from collections import Counter

import httpx

CRTSH_URL = "https://crt.sh/"


def parse_certs(domain: str, entries: list[dict]) -> dict:
    subdomains: set[str] = set()
    issuers: Counter = Counter()
    first_seen = None

    for entry in entries:
        for name in entry.get("name_value", "").splitlines():
            name = name.strip().lower().removeprefix("*.")
            if name == domain or name.endswith("." + domain):
                subdomains.add(name)

        issuer = entry.get("issuer_name", "")
        org = next((p.split("=", 1)[1] for p in issuer.split(", ") if p.startswith("O=")), None)
        if org:
            issuers[org] += 1

        logged = entry.get("entry_timestamp")
        if logged and (first_seen is None or logged < first_seen):
            first_seen = logged

    return {
        "total_certs": len(entries),
        "subdomains": sorted(subdomains),
        "subdomain_count": len(subdomains),
        "top_issuers": issuers.most_common(5),
        "first_cert_logged": first_seen,
    }


async def lookup(domain: str, client: httpx.AsyncClient) -> dict:
    # crt.sh is free but slow under load, hence the long timeout
    resp = await client.get(CRTSH_URL, params={"q": f"%.{domain}", "output": "json"}, timeout=45.0)
    resp.raise_for_status()
    return parse_certs(domain, resp.json())
