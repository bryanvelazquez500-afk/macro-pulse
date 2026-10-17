"""Thin async client for the SEC EDGAR APIs.

Endpoints used:
  - https://www.sec.gov/files/company_tickers.json        (ticker -> CIK lookup)
  - https://data.sec.gov/submissions/CIK##########.json    (Submissions)
  - https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json  (CompanyFacts)
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.core.config import Settings, get_settings


class SecApiError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class CompanyNotFoundError(SecApiError):
    def __init__(self, identifier: str):
        super().__init__(f"No SEC registrant found for '{identifier}'", status_code=404)


class _RateLimiter:
    """Spaces out requests so we never exceed the SEC's requests-per-second cap."""

    def __init__(self, per_second: int):
        self._interval = 1.0 / per_second
        self._lock = asyncio.Lock()
        self._next_slot = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self._next_slot:
                await asyncio.sleep(self._next_slot - now)
                now = self._next_slot
            self._next_slot = now + self._interval


class TTLCache:
    def __init__(self, ttl_seconds: int):
        self._ttl = ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if time.monotonic() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.monotonic() + self._ttl, value)


def format_cik(cik: int | str) -> str:
    """EDGAR URLs require the CIK zero-padded to 10 digits."""
    return str(int(cik)).zfill(10)


class SecEdgarClient:
    def __init__(self, settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings or get_settings()
        self._client = httpx.AsyncClient(
            # Strict SEC-mandated header format: "User-Agent: InvestmentStation student@domain.com"
            headers={
                "User-Agent": self.settings.sec_user_agent,
                "Accept-Encoding": "gzip, deflate",
                "Accept": "application/json",
            },
            timeout=self.settings.sec_timeout_seconds,
            transport=transport,
        )
        self._limiter = _RateLimiter(self.settings.sec_max_requests_per_second)
        self._cache = TTLCache(self.settings.cache_ttl_seconds)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _fetch(self, url: str, accept: str = "application/json") -> httpx.Response:
        await self._limiter.wait()
        try:
            response = await self._client.get(url, headers={"Accept": accept})
        except httpx.HTTPError as exc:
            raise SecApiError(f"Network error contacting SEC: {exc}") from exc

        if response.status_code == 404:
            raise SecApiError("Resource not found on SEC EDGAR", status_code=404)
        if response.status_code == 403:
            raise SecApiError("SEC rejected the request (check User-Agent header / rate limits)", status_code=502)
        if response.status_code == 429:
            raise SecApiError("SEC rate limit exceeded; retry shortly", status_code=503)
        if response.is_error:
            raise SecApiError(f"SEC returned HTTP {response.status_code}")
        return response

    async def _get_json(self, url: str, cache: bool = True) -> Any:
        cached = self._cache.get(url)
        if cached is not None:
            return cached
        data = (await self._fetch(url)).json()
        if cache:
            self._cache.set(url, data)
        return data

    async def get_filing_document(self, url: str) -> str:
        """Raw HTML of a filing document from the EDGAR archive (not cached: documents run to megabytes)."""
        if not url.startswith(f"{self.settings.sec_www_base_url}/Archives/edgar/data/"):
            raise SecApiError("Refusing to fetch a non-EDGAR archive URL", status_code=400)
        return (await self._fetch(url, accept="text/html")).text

    async def get_ticker_map(self) -> dict[str, dict[str, Any]]:
        """Returns {TICKER: {"cik": int, "ticker": str, "title": str}}."""
        raw = await self._get_json(f"{self.settings.sec_www_base_url}/files/company_tickers.json")
        return {
            entry["ticker"].upper(): {"cik": int(entry["cik_str"]), "ticker": entry["ticker"].upper(), "title": entry["title"]}
            for entry in raw.values()
        }

    async def resolve_cik(self, identifier: str) -> int:
        """Accepts either a ticker symbol (AAPL) or a numeric CIK (320193 / 0000320193)."""
        identifier = identifier.strip()
        if identifier.isdigit():
            return int(identifier)
        ticker_map = await self.get_ticker_map()
        # EDGAR uses '-' for share classes (BRK-B); accept '.' too.
        match = ticker_map.get(identifier.upper().replace(".", "-"))
        if match is None:
            raise CompanyNotFoundError(identifier)
        return match["cik"]

    async def get_submissions(self, cik: int | str) -> dict[str, Any]:
        try:
            return await self._get_json(f"{self.settings.sec_data_base_url}/submissions/CIK{format_cik(cik)}.json")
        except SecApiError as exc:
            if exc.status_code == 404:
                raise CompanyNotFoundError(str(cik)) from exc
            raise

    async def get_company_facts(self, cik: int | str, cache: bool = True) -> dict[str, Any]:
        """`cache=False` for bulk one-off reads: each parsed CompanyFacts holds ~15–20 MB of Python objects."""
        try:
            return await self._get_json(
                f"{self.settings.sec_data_base_url}/api/xbrl/companyfacts/CIK{format_cik(cik)}.json", cache=cache
            )
        except SecApiError as exc:
            if exc.status_code == 404:
                raise SecApiError(f"No XBRL financial data available for CIK {cik}", status_code=404) from exc
            raise
