"""HTTP caching for API responses, so browsers reuse data across reloads and tab switches.

stale-while-revalidate lets the browser show the last response instantly while it fetches a fresh one
in the background. Lifetimes follow how often the data changes: filings at most daily, prices by the
minute, headlines every few minutes.
"""

from __future__ import annotations

import re

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# (path pattern, Cache-Control) — first match wins; unmatched GETs get no header.
RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^/api/health$"), "no-store"),
    (re.compile(r"^/api/quotes/"), "public, max-age=30, stale-while-revalidate=300"),
    (re.compile(r"^/api/companies/[^/]+/news$"), "public, max-age=120, stale-while-revalidate=900"),
    (re.compile(r"^/api/(macro/factors|companies/[^/]+/(valuation-inputs|dcf-inputs))$"), "public, max-age=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/universe/search$"), "public, max-age=3600, stale-while-revalidate=86400"),
    (re.compile(r"^/api/discovery/"), "public, max-age=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/"), "public, max-age=600, stale-while-revalidate=86400"),  # filings-based data
]


def cache_control_for(method: str, path: str, status: int) -> str | None:
    if method != "GET" or status != 200:
        return None
    return next((value for pattern, value in RULES if pattern.search(path)), None)


class CacheHeaders:
    """ASGI middleware adding Cache-Control to successful GET responses."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                value = cache_control_for(scope["method"], scope["path"], message["status"])
                headers = list(message.get("headers", []))
                if value and not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", value.encode()))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_header)
