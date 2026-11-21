"""One ordinary HTTPS GET to the homepage - same as a browser visit - then
read headers and HTML for stack signatures and missing security headers."""

import re

import httpx

SECURITY_HEADERS = (
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
)

# (technology, where to look, pattern)
SIGNATURES = (
    ("Cloudflare", "header", "cf-ray"),
    ("Fastly", "header", "x-fastly-request-id"),
    ("Amazon CloudFront", "header", "x-amz-cf-id"),
    ("Vercel", "header", "x-vercel-id"),
    ("Netlify", "header", "x-nf-request-id"),
    ("GitHub Pages", "header", "x-github-request-id"),
    ("WordPress", "html", r"wp-content|wp-includes"),
    ("Next.js", "html", r"__NEXT_DATA__|/_next/static"),
    ("Nuxt", "html", r"__NUXT__|/_nuxt/"),
    ("React", "html", r"data-reactroot|react-dom"),
    ("Angular", "html", r"ng-version="),
    ("Vue.js", "html", r"data-v-[0-9a-f]{8}"),
    ("Shopify", "html", r"cdn\.shopify\.com"),
    ("Wix", "html", r"static\.wixstatic\.com"),
    ("Squarespace", "html", r"static1\.squarespace\.com"),
    ("Google Analytics", "html", r"googletagmanager\.com|google-analytics\.com"),
    ("jQuery", "html", r"jquery(\.min)?\.js"),
    ("Bootstrap", "html", r"bootstrap(\.min)?\.(css|js)"),
)

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def fingerprint(headers: httpx.Headers, html: str) -> dict:
    detected = []
    for tech, where, pattern in SIGNATURES:
        if where == "header" and pattern in headers:
            detected.append(tech)
        elif where == "html" and re.search(pattern, html, re.IGNORECASE):
            detected.append(tech)

    title_match = TITLE_RE.search(html)
    present = [h for h in SECURITY_HEADERS if h in headers]

    return {
        "title": " ".join(title_match.group(1).split())[:200] if title_match else None,
        "server": headers.get("server"),
        "powered_by": headers.get("x-powered-by"),
        "technologies": detected,
        "security_headers": {
            "present": present,
            "missing": [h for h in SECURITY_HEADERS if h not in headers],
            "score": f"{len(present)}/{len(SECURITY_HEADERS)}",
        },
    }


async def lookup(domain: str, client: httpx.AsyncClient) -> dict:
    resp = await client.get(f"https://{domain}", follow_redirects=True, timeout=15.0)
    result = fingerprint(resp.headers, resp.text[:500_000])
    result["final_url"] = str(resp.url)
    result["status_code"] = resp.status_code
    result["redirect_chain"] = [str(r.url) for r in resp.history]
    return result
