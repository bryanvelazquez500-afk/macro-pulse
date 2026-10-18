"""Latest share price, for valuation multiples (P/E, PEG) that SEC data alone can't provide.

Source order:
  1. Financial Modeling Prep `/stable/profile` (price + currency) when FMP_API_KEY is set.
     The free plan covers US listings; anything else falls through.
  2. Yahoo Finance's public chart endpoint. No key, and it covers international listings, but it's
     unofficial and undocumented: it may rate-limit or change without notice, so failures are
     reported as "no price" rather than errors.

Prices are normalized to whole currency units: London quotes in pence (GBp/GBX), Johannesburg in
cents (ZAc) and Tel Aviv in agorot (ILA) are divided by 100.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

from app.core.config import Settings, get_settings
from app.services.fmp_client import FmpClient, FmpError
from app.services.listings import parse_listing
from app.services.sec_client import TTLCache

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# Minor-unit quote currencies → (ISO currency, divisor)
_MINOR_UNITS = {"GBp": ("GBP", 100), "GBX": ("GBP", 100), "ZAc": ("ZAR", 100), "ZAC": ("ZAR", 100), "ILA": ("ILS", 100)}


@dataclass(frozen=True)
class Snapshot:
    """Price plus the context a stock list needs: day change and 52-week range (whole currency units)."""

    symbol: str
    name: str | None
    exchange: str | None
    price: float
    currency: str
    change_pct: float | None  # vs. previous close, in percent
    week52_low: float | None
    week52_high: float | None
    source: str


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: float  # in whole units of `currency`
    currency: str
    source: str  # "Financial Modeling Prep" | "Yahoo Finance"
    as_of: str | None  # ISO timestamp of the price, when the source gives one


def normalize_price(price: float, currency: str) -> tuple[float, str]:
    if currency in _MINOR_UNITS:
        iso, divisor = _MINOR_UNITS[currency]
        return price / divisor, iso
    return price, currency.upper()


def yahoo_symbol(symbol: str) -> str:
    """Yahoo uses '-' for US share classes (BRK-B) and the same suffixes as us for exchanges."""
    return symbol if parse_listing(symbol) else symbol.replace(".", "-")


class QuoteService:
    def __init__(self, fmp: FmpClient, settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.fmp = fmp
        self.settings = settings or get_settings()
        self._client = httpx.AsyncClient(
            timeout=10.0,
            # Yahoo rejects clients without a browser-like User-Agent.
            headers={"User-Agent": "Mozilla/5.0 (MacroPulse)", "Accept": "application/json"},
            transport=transport,
        )
        self._cache = TTLCache(5 * 60)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _chart_meta(self, symbol: str) -> dict | None:
        """Yahoo chart metadata; retries briefly when Yahoo throttles a burst (long scout lists)."""
        for delay in (0.0, 0.8, 2.0):
            if delay:
                await asyncio.sleep(delay)
            try:
                response = await self._client.get(YAHOO_CHART_URL.format(symbol=yahoo_symbol(symbol)), params={"range": "1d", "interval": "1d"})
            except httpx.HTTPError:
                continue
            if response.status_code == 429 or response.status_code >= 500:
                continue
            try:
                return response.json()["chart"]["result"][0]["meta"]
            except (ValueError, KeyError, IndexError, TypeError):
                return None  # unknown symbol: retrying won't help
        return None

    async def get_quote(self, symbol: str) -> Quote | None:
        symbol = symbol.strip().upper()
        cached = self._cache.get(symbol)
        if cached is not None:
            return cached
        quote = await self._from_fmp(symbol) or await self._from_yahoo(symbol)
        if quote is not None:
            self._cache.set(symbol, quote)
        return quote

    async def get_snapshot(self, symbol: str) -> Snapshot | None:
        """Yahoo's chart metadata carries day change and the 52-week range in one call. None on any failure."""
        symbol = symbol.strip().upper()
        key = f"snapshot:{symbol}"
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        meta = await self._chart_meta(symbol)
        if meta is None:
            return None
        price, currency = meta.get("regularMarketPrice"), meta.get("currency")
        if not isinstance(price, (int, float)) or price <= 0 or not currency:
            return None
        divisor = _MINOR_UNITS[currency][1] if currency in _MINOR_UNITS else 1
        previous = meta.get("chartPreviousClose") or meta.get("previousClose")
        num = lambda v: float(v) / divisor if isinstance(v, (int, float)) else None  # noqa: E731
        snapshot = Snapshot(
            symbol=symbol,
            name=meta.get("longName") or meta.get("shortName"),
            exchange=meta.get("fullExchangeName") or meta.get("exchangeName"),
            price=float(price) / divisor,
            currency=normalize_price(1, currency)[1],
            change_pct=(price / previous - 1) * 100 if isinstance(previous, (int, float)) and previous > 0 else None,
            week52_low=num(meta.get("fiftyTwoWeekLow")),
            week52_high=num(meta.get("fiftyTwoWeekHigh")),
            source="Yahoo Finance",
        )
        self._cache.set(key, snapshot)
        return snapshot

    async def _from_fmp(self, symbol: str) -> Quote | None:
        if not self.fmp.configured:
            return None
        try:
            profile = await self.fmp.get_profile(symbol)
        except FmpError:
            return None
        price, currency = profile.get("price"), profile.get("currency")
        if not isinstance(price, (int, float)) or price <= 0 or not currency:
            return None
        value, iso = normalize_price(float(price), currency)
        return Quote(symbol, value, iso, "Financial Modeling Prep", None)

    async def _from_yahoo(self, symbol: str) -> Quote | None:
        meta = await self._chart_meta(symbol)
        if meta is None:
            return None
        price, currency = meta.get("regularMarketPrice"), meta.get("currency")
        if not isinstance(price, (int, float)) or price <= 0 or not currency:
            return None
        value, iso = normalize_price(float(price), currency)
        ts = meta.get("regularMarketTime")
        as_of = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if isinstance(ts, int) else None
        return Quote(symbol, value, iso, "Yahoo Finance", as_of)
