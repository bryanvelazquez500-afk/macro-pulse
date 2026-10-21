"""Keeps the most-visited companies in the server's caches.

The site opens on Apple, and its big-tech peers are the first chips people click, so after every start
(and every deploy, which starts the server with empty caches) these requests are replayed in the
background, then refreshed before the one-hour cache expires. Visitors then never wait on a cold SEC
fetch for them. Requests go through the app itself (ASGI, no network), exercising the real code paths.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

log = logging.getLogger(__name__)

FOCUS = "AAPL"
PEERS = ("MSFT", "NVDA", "GOOGL", "AMZN", "META")
# Exactly the requests the site makes on first load (same paths and query strings), so they hit the cache.
FIRST_LOAD = (
    f"/api/companies/{FOCUS}",
    f"/api/companies/{FOCUS}/financials?period=annual&limit=12",
    f"/api/companies/{FOCUS}/peers?limit=6",
    f"/api/companies/{FOCUS}/valuation-inputs",
    f"/api/companies/{FOCUS}/dcf-inputs",
    f"/api/companies/{FOCUS}/news?limit=10",
)
PEER_LOAD = tuple(p for t in PEERS for p in (f"/api/companies/{t}", f"/api/companies/{t}/financials?period=annual&limit=12"))
REFRESH_SECONDS = 45 * 60  # inside the 60-minute cache TTL


async def warm(app, paths: tuple[str, ...] = FIRST_LOAD + PEER_LOAD) -> int:
    """Replay `paths` against the app; returns how many succeeded. Failures are logged, never raised."""
    ok = 0
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://warmup", timeout=60) as client:
        for path in paths:  # sequential: gentle on the SEC rate limit
            try:
                r = await client.get(path)
                ok += r.status_code == 200
            except Exception as e:  # noqa: BLE001 — warming must never take the server down
                log.warning("warm-up %s failed: %s", path, e)
    return ok


async def keep_warm(app, delay: float = 2.0) -> None:
    await asyncio.sleep(delay)  # let startup finish first
    while True:
        n = await warm(app)
        log.info("cache warm-up: %d requests cached", n)
        await asyncio.sleep(REFRESH_SECONDS)
