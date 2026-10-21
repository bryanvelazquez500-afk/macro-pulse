"""Speed features: browser cache headers and the server-side cache warm-up."""

import asyncio

from fastapi import FastAPI

from app.core.cache_headers import CacheHeaders, cache_control_for
from app.services import warmup


def test_cache_control_rules():
    assert cache_control_for("GET", "/api/health", 200) == "no-store"
    assert "max-age=30" in cache_control_for("GET", "/api/quotes/AAPL", 200)
    assert "max-age=120" in cache_control_for("GET", "/api/companies/AAPL/news", 200)
    assert "max-age=300" in cache_control_for("GET", "/api/companies/AAPL/dcf-inputs", 200)
    fin = cache_control_for("GET", "/api/companies/AAPL/financials", 200)
    assert "max-age=600" in fin and "stale-while-revalidate=86400" in fin
    # Never cache errors or writes.
    assert cache_control_for("GET", "/api/companies/ZZZZ", 404) is None
    assert cache_control_for("POST", "/api/macro/sync", 200) is None


def _app() -> tuple[FastAPI, list[str]]:
    app = FastAPI()
    app.add_middleware(CacheHeaders)
    seen: list[str] = []

    @app.get("/api/companies/{ident}")
    async def profile(ident: str):
        seen.append(ident)
        return {"id": ident}

    return app, seen


def test_middleware_sets_header():
    import httpx

    app, _ = _app()

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.get("/api/companies/AAPL")

    r = asyncio.run(go())
    assert r.headers["cache-control"].startswith("public, max-age=600")


def test_warm_replays_paths_and_survives_failures():
    app, seen = _app()
    ok = asyncio.run(warmup.warm(app, ("/api/companies/AAPL", "/api/companies/MSFT", "/api/missing")))
    assert ok == 2 and seen == ["AAPL", "MSFT"]
    # The first-load list matches what the site requests on open.
    assert "/api/companies/AAPL/financials?period=annual&limit=12" in warmup.FIRST_LOAD
