"""Async client for Financial Modeling Prep's "stable" API — the global (non-SEC) data pipeline.

Endpoints used (all take `symbol` and `apikey`):
  - /stable/profile
  - /stable/income-statement, /stable/balance-sheet-statement, /stable/cash-flow-statement
    (`period=annual|quarter`, `limit=N`)

FMP reports plan restrictions in the response body rather than by status code alone, e.g.
"Premium Query Parameter" (a limit above 5 on the free plan), "Premium Endpoint" /
"Special Endpoint" / "Exclusive Endpoint", or "... US stocks only ..." for non-US symbols on a
free key. Those are classified into `FmpError`s with an HTTP status the API can pass through.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings, get_settings
from app.services.gaap_mapping import PeriodType
from app.services.sec_client import TTLCache

FREE_PLAN_PERIOD_LIMIT = 5

STATEMENTS = ("income-statement", "balance-sheet-statement", "cash-flow-statement")


# Machine-readable error code for anything that needs an API key (or a paid plan) the backend doesn't have.
# The frontend shows these as a neutral "info unavailable at the moment" button instead of the raw message.
API_KEY_REQUIRED = "api_key_required"


class FmpError(Exception):
    def __init__(self, message: str, status_code: int = 502, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class FmpNotConfiguredError(FmpError):
    def __init__(self, symbol: str):
        super().__init__(
            f"{symbol} is not an SEC registrant, so it needs the global data pipeline: set FMP_API_KEY "
            "in backend/.env to load it from Financial Modeling Prep.",
            status_code=503,
            code=API_KEY_REQUIRED,
        )


class FmpPlanError(FmpError):
    """The key is valid but its plan doesn't include this data (HTTP 402 Payment Required)."""

    def __init__(self, message: str):
        super().__init__(message, status_code=402, code=API_KEY_REQUIRED)


class _PremiumQueryParameter(Exception):
    """Internal: the requested `limit` exceeds the plan's cap."""


@dataclass(frozen=True)
class FmpStatements:
    income: list[dict[str, Any]]
    balance: list[dict[str, Any]]
    cash_flow: list[dict[str, Any]]


def _error_text(payload: Any) -> str | None:
    if isinstance(payload, dict):
        return str(payload.get("Error Message") or payload.get("error") or payload.get("message") or "") or None
    return None


def _classify(symbol: str, text: str, status: int) -> Exception:
    lowered = text.lower()
    if "premium query parameter" in lowered:
        return _PremiumQueryParameter()
    if "invalid api key" in lowered or status == 401:
        return FmpError("Financial Modeling Prep rejected FMP_API_KEY — check the key in backend/.env.", status_code=503, code=API_KEY_REQUIRED)
    restricted_endpoint = "endpoint" in lowered and any(w in lowered for w in ("premium", "special", "exclusive"))
    if "us stocks only" in lowered or restricted_endpoint or status in (402, 403):
        return FmpPlanError(
            f"Financial Modeling Prep's current plan doesn't cover {symbol} — the free plan is limited to US "
            "listings; international statements need a paid FMP plan."
        )
    if "limit reach" in lowered or status == 429:
        return FmpError("Financial Modeling Prep request quota reached (free plan: 250/day); retry later.", status_code=429)
    return FmpError(f"Financial Modeling Prep error for {symbol}: {text[:200] or f'HTTP {status}'}")


class FmpClient:
    def __init__(self, settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings or get_settings()
        self._client = httpx.AsyncClient(
            base_url=self.settings.fmp_base_url.rstrip("/") + "/",
            timeout=self.settings.fmp_timeout_seconds,
            headers={"Accept": "application/json"},
            transport=transport,
        )
        self._cache = TTLCache(self.settings.fmp_cache_ttl_seconds)
        # Lowered to the free plan's cap after the first "Premium Query Parameter" response.
        self._period_limit = self.settings.fmp_statement_limit

    @property
    def configured(self) -> bool:
        return self.settings.fmp_api_key is not None and bool(self.settings.fmp_api_key.get_secret_value())

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, symbol: str, **params: Any) -> list[dict[str, Any]]:
        if not self.configured:
            raise FmpNotConfiguredError(symbol)
        cache_key = f"{path}?symbol={symbol}&" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        query = {"symbol": symbol, **params, "apikey": self.settings.fmp_api_key.get_secret_value()}
        try:
            response = await self._client.get(path, params=query)
        except httpx.HTTPError as exc:
            # Never echo the request URL: it carries the API key.
            raise FmpError(f"Network error contacting Financial Modeling Prep ({type(exc).__name__})") from None

        try:
            payload = response.json()
        except ValueError:
            payload = None
        if response.is_error or not isinstance(payload, list):
            raise _classify(symbol, _error_text(payload) or response.text, response.status_code)

        self._cache.set(cache_key, payload)
        return payload

    async def _statement(self, path: str, symbol: str, period: str) -> list[dict[str, Any]]:
        try:
            return await self._get(path, symbol, period=period, limit=self._period_limit)
        except _PremiumQueryParameter:
            if self._period_limit <= FREE_PLAN_PERIOD_LIMIT:
                raise FmpPlanError(f"Financial Modeling Prep's current plan doesn't allow this query for {symbol}.") from None
            self._period_limit = FREE_PLAN_PERIOD_LIMIT
            return await self._statement(path, symbol, period)

    async def get_statements(self, symbol: str, period_type: PeriodType) -> FmpStatements:
        period = "annual" if period_type is PeriodType.ANNUAL else "quarter"
        income, balance, cash_flow = await asyncio.gather(*(self._statement(s, symbol, period) for s in STATEMENTS))
        if not income:
            raise FmpError(f"Financial Modeling Prep has no {period_type.value} statements for {symbol}", status_code=404)
        return FmpStatements(income=income, balance=balance, cash_flow=cash_flow)

    async def get_profile(self, symbol: str) -> dict[str, Any]:
        rows = await self._get("profile", symbol)
        if not rows:
            raise FmpError(f"Financial Modeling Prep has no company named {symbol}", status_code=404)
        return rows[0]
