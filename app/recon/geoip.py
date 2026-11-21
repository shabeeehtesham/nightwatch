import httpx

# ip-api.com free tier: HTTP only, 45 req/min, non-commercial use
IP_API_URL = "http://ip-api.com/json/{ip}"
FIELDS = "status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,query"


async def lookup(ip: str, client: httpx.AsyncClient) -> dict:
    resp = await client.get(IP_API_URL.format(ip=ip), params={"fields": FIELDS})
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "success":
        raise ValueError(data.get("message", "geo lookup failed"))
    return {
        "ip": data["query"],
        "country": data.get("country"),
        "country_code": data.get("countryCode"),
        "region": data.get("regionName"),
        "city": data.get("city"),
        "lat": data.get("lat"),
        "lon": data.get("lon"),
        "isp": data.get("isp"),
        "org": data.get("org"),
        "asn": data.get("as"),
    }
