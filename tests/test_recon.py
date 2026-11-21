import httpx

from app.recon import cert_transparency, dns_records, registration, wayback, web_fingerprint


def test_rdap_parsing():
    payload = {
        "events": [
            {"eventAction": "registration", "eventDate": "1997-09-15T04:00:00Z"},
            {"eventAction": "expiration", "eventDate": "2028-09-14T04:00:00Z"},
        ],
        "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "MarkMonitor Inc."]]]}],
        "nameservers": [{"ldhName": "NS2.GOOGLE.COM"}, {"ldhName": "NS1.GOOGLE.COM"}],
        "secureDNS": {"delegationSigned": False},
        "status": ["client delete prohibited"],
    }
    out = registration.parse_rdap(payload)
    assert out["registrar"] == "MarkMonitor Inc."
    assert out["registered"] == "1997-09-15T04:00:00Z"
    assert out["nameservers"] == ["ns1.google.com", "ns2.google.com"]
    assert out["dnssec"] is False


def test_cert_transparency_dedupes_and_scopes_subdomains():
    entries = [
        {"name_value": "*.example.com\nexample.com", "issuer_name": "C=US, O=Let's Encrypt, CN=R3", "entry_timestamp": "2021-01-01"},
        {"name_value": "vpn.example.com\nstaging.example.com", "issuer_name": "C=US, O=Let's Encrypt, CN=R3", "entry_timestamp": "2019-05-01"},
        {"name_value": "notexample.com\nexample.com.evil.net", "issuer_name": "C=US, O=Other, CN=X", "entry_timestamp": "2022-01-01"},
    ]
    out = cert_transparency.parse_certs("example.com", entries)
    assert out["subdomains"] == ["example.com", "staging.example.com", "vpn.example.com"]
    assert out["first_cert_logged"] == "2019-05-01"
    assert out["top_issuers"][0] == ("Let's Encrypt", 2)


def test_email_posture_flags_missing_or_monitor_only_dmarc():
    assert dns_records._email_posture(["v=spf1 -all"], [])["spoofable"] is True
    assert dns_records._email_posture(["v=spf1 -all"], ["v=DMARC1; p=none"])["spoofable"] is True
    good = dns_records._email_posture(["v=spf1 -all"], ["v=DMARC1; p=reject; rua=mailto:x@y.z"])
    assert good["spoofable"] is False
    assert good["dmarc_policy"] == "reject"


def test_web_fingerprint_detects_stack_and_missing_headers():
    headers = httpx.Headers({"server": "cloudflare", "cf-ray": "abc", "strict-transport-security": "max-age=1"})
    html = '<html><head><title> My  Site </title><script src="/_next/static/x.js"></script></head></html>'
    out = web_fingerprint.fingerprint(headers, html)
    assert out["title"] == "My Site"
    assert {"Cloudflare", "Next.js"} <= set(out["technologies"])
    assert out["security_headers"]["score"] == "1/6"
    assert "content-security-policy" in out["security_headers"]["missing"]


def test_wayback_summary():
    rows = [["timestamp"], ["20090301000000"], ["20150601000000"], ["20261101000000"]]
    out = wayback.parse_cdx(rows)
    assert out["first_snapshot"] == "2009-03-01"
    assert out["last_snapshot"] == "2026-11-01"
    assert out["years_active"] == ["2009", "2015", "2026"]
    assert wayback.parse_cdx([["timestamp"]])["first_snapshot"] is None
