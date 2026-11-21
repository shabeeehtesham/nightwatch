import asyncio
import time
from functools import wraps


def ttl_cache(seconds: float):
    """Caches an async function's result per argument tuple. Concurrent
    callers during a refresh share one in-flight request instead of each
    hitting the upstream API - matters for rate-limited sources like
    OpenSky."""

    def decorator(fn):
        store: dict[tuple, tuple[float, object]] = {}
        locks: dict[tuple, asyncio.Lock] = {}

        @wraps(fn)
        async def wrapper(*args):
            key = args
            hit = store.get(key)
            if hit and time.monotonic() - hit[0] < seconds:
                return hit[1]
            lock = locks.setdefault(key, asyncio.Lock())
            async with lock:
                hit = store.get(key)
                if hit and time.monotonic() - hit[0] < seconds:
                    return hit[1]
                value = await fn(*args)
                store[key] = (time.monotonic(), value)
                return value

        return wrapper

    return decorator
