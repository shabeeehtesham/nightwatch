"""Checks whether a handle exists across public platforms.

Uses each platform's public API where one exists rather than scraping
profile pages - status codes on HTML pages are unreliable (soft 404s,
login walls, bot challenges). A check that can't tell gets reported as
"unknown", never guessed as found or missing.
"""

import asyncio
from dataclasses import dataclass
from typing import Callable

import httpx


@dataclass(frozen=True)
class Platform:
    name: str
    category: str
    check_url: str
    profile_url: str
    # response -> True (exists) / False (missing) / None (can't tell)
    detect: Callable[[httpx.Response], bool | None]


def by_status(resp: httpx.Response) -> bool | None:
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    return None


def json_non_empty(resp: httpx.Response) -> bool | None:
    if resp.status_code != 200:
        return None
    return bool(resp.json())


def codeforces(resp: httpx.Response) -> bool | None:
    if resp.status_code == 200:
        return True
    if resp.status_code == 400 and "not found" in resp.text:
        return False
    return None


def bluesky(resp: httpx.Response) -> bool | None:
    if resp.status_code == 200:
        return True
    if resp.status_code == 400:
        return False
    return None


# Each check was verified against a known real account and a random string.
# Dropped after failing that test: Bitbucket (user API gone), PyPI and
# Keybase (200 for nonexistent users), Docker Hub (inconsistent), Reddit
# (blocks unauthenticated API calls).
PLATFORMS = (
    Platform("GitHub", "code", "https://api.github.com/users/{u}", "https://github.com/{u}", by_status),
    Platform("GitLab", "code", "https://gitlab.com/api/v4/users?username={u}", "https://gitlab.com/{u}", json_non_empty),
    Platform("Hugging Face", "ai", "https://huggingface.co/api/users/{u}/overview", "https://huggingface.co/{u}", by_status),
    Platform("Dev.to", "writing", "https://dev.to/api/users/by_username?url={u}", "https://dev.to/{u}", by_status),
    Platform("Hacker News", "social", "https://hacker-news.firebaseio.com/v0/user/{u}.json", "https://news.ycombinator.com/user?id={u}", json_non_empty),
    Platform("Mastodon", "social", "https://mastodon.social/api/v1/accounts/lookup?acct={u}", "https://mastodon.social/@{u}", by_status),
    Platform("Bluesky", "social", "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={u}.bsky.social", "https://bsky.app/profile/{u}.bsky.social", bluesky),
    Platform("Gravatar", "identity", "https://en.gravatar.com/{u}.json", "https://gravatar.com/{u}", by_status),
    Platform("Chess.com", "gaming", "https://api.chess.com/pub/player/{u}", "https://www.chess.com/member/{u}", by_status),
    Platform("Lichess", "gaming", "https://lichess.org/api/user/{u}", "https://lichess.org/@/{u}", by_status),
    Platform("Codeforces", "code", "https://codeforces.com/api/user.info?handles={u}", "https://codeforces.com/profile/{u}", codeforces),
)


async def _check(platform: Platform, username: str, client: httpx.AsyncClient) -> dict:
    result = {
        "platform": platform.name,
        "category": platform.category,
        "url": platform.profile_url.format(u=username),
    }
    try:
        resp = await client.get(platform.check_url.format(u=username), timeout=10.0)
        found = platform.detect(resp)
    except (httpx.HTTPError, ValueError):
        found = None
    result["status"] = {True: "found", False: "missing", None: "unknown"}[found]
    return result


async def enumerate_handle(username: str, client: httpx.AsyncClient) -> dict:
    results = await asyncio.gather(*(_check(p, username, client) for p in PLATFORMS))
    found = [r for r in results if r["status"] == "found"]
    return {
        "checked": len(results),
        "found_count": len(found),
        "results": sorted(results, key=lambda r: ("found", "unknown", "missing").index(r["status"])),
    }


async def github_profile(username: str, client: httpx.AsyncClient) -> dict | None:
    resp = await client.get(f"https://api.github.com/users/{username}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    user = resp.json()

    repos_resp = await client.get(
        f"https://api.github.com/users/{username}/repos",
        params={"sort": "updated", "per_page": 100},
    )
    repos = repos_resp.json() if repos_resp.status_code == 200 else []
    languages: dict[str, int] = {}
    for repo in repos:
        if repo.get("language") and not repo.get("fork"):
            languages[repo["language"]] = languages.get(repo["language"], 0) + 1

    return {
        "name": user.get("name"),
        "bio": user.get("bio"),
        "company": user.get("company"),
        "location": user.get("location"),
        "blog": user.get("blog") or None,
        "public_repos": user.get("public_repos"),
        "followers": user.get("followers"),
        "following": user.get("following"),
        "created_at": user.get("created_at"),
        "avatar_url": user.get("avatar_url"),
        "top_languages": sorted(languages.items(), key=lambda kv: kv[1], reverse=True)[:6],
        "recent_repos": [
            {"name": r["name"], "stars": r.get("stargazers_count", 0), "language": r.get("language")}
            for r in repos[:5]
        ],
    }
