import dns.asyncresolver
import dns.exception
import dns.resolver

RECORD_TYPES = ("A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA")


async def _query(resolver: dns.asyncresolver.Resolver, name: str, rtype: str) -> list[str]:
    try:
        answer = await resolver.resolve(name, rtype)
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, dns.resolver.NoNameservers, dns.exception.Timeout):
        return []
    return [r.to_text().strip('"') for r in answer]


def _email_posture(txt_records: list[str], dmarc_records: list[str]) -> dict:
    spf = next((r for r in txt_records if r.lower().startswith("v=spf1")), None)
    dmarc = next((r for r in dmarc_records if r.lower().startswith("v=dmarc1")), None)
    policy = None
    if dmarc:
        for part in dmarc.split(";"):
            key, _, value = part.strip().partition("=")
            if key.lower() == "p":
                policy = value.lower()
    return {
        "spf": spf,
        "dmarc": dmarc,
        "dmarc_policy": policy,
        # p=none means spoofed mail is only reported, never rejected
        "spoofable": spf is None or dmarc is None or policy == "none",
    }


async def lookup(domain: str) -> dict:
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = 8.0

    records = {rtype: await _query(resolver, domain, rtype) for rtype in RECORD_TYPES}
    dmarc = await _query(resolver, f"_dmarc.{domain}", "TXT")

    return {
        "records": records,
        "email_security": _email_posture(records["TXT"], dmarc),
    }
