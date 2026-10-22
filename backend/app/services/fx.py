"""Live currency conversion to USD (Yahoo FX quotes), for showing foreign filers' figures in dollars.

Rates are the latest market quote ("EURUSD=X"), cached ten minutes. They convert *display* values only:
every period is translated at today's rate, so growth rates and ratios are unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from app.services.sec_client import TTLCache

TTL_SECONDS = 10 * 60


@dataclass(frozen=True)
class FxRate:
    currency: str
    usd_per_unit: float
    as_of: str  # ISO time of the quote
    source: str = "Yahoo Finance"


class FxService:
    def __init__(self, quotes) -> None:
        self.quotes = quotes
        self._cache = TTLCache(TTL_SECONDS)

    async def usd_rate(self, currency: str) -> FxRate | None:
        cur = currency.strip().upper()
        if cur == "USD":
            return FxRate("USD", 1.0, datetime.now(timezone.utc).isoformat(timespec="seconds"), "identity")
        if not (len(cur) == 3 and cur.isalpha()):
            return None
        cached = self._cache.get(cur)
        if cached is not None:
            return cached
        rate = await self._quote(f"{cur}USD=X", invert=False) or await self._quote(f"USD{cur}=X", invert=True)
        if rate is not None:
            rate = FxRate(cur, rate[0], rate[1])
            self._cache.set(cur, rate)
        return rate

    async def _quote(self, pair: str, invert: bool) -> tuple[float, str] | None:
        meta = await self.quotes._chart_meta(pair)
        price = (meta or {}).get("regularMarketPrice")
        if not price or price <= 0:
            return None
        when = meta.get("regularMarketTime")
        as_of = datetime.fromtimestamp(when, timezone.utc).isoformat(timespec="seconds") if when else datetime.now(timezone.utc).isoformat(timespec="seconds")
        return (1 / price if invert else float(price)), as_of
