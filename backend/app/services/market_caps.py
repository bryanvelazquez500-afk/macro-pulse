"""Live market capitalization for the scout lists: price × shares outstanding.

Shares come from SEC EDGAR's XBRL "frames" API, which returns one concept for every filer in a single
call: the cover-page `dei:EntityCommonStockSharesOutstanding` of each 10-K/10-Q/20-F/40-F, falling back to
quarterly diluted weighted-average shares for companies that only tag shares per class (Alphabet, Meta).
A handful of requests covers every SEC registrant, so ranking a 200-stock list needs no per-company filings.

Companies that aren't SEC registrants have no free share count, so they have no market cap and rank
after those that do. US depositary receipts (other than 1:1 listings) are skipped: their price is for
a bundle of shares, so price × ordinary shares would be wrong.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date

from app.services.quotes import QuoteService
from app.services.sec_client import SecApiError, SecEdgarClient, TTLCache

logger = logging.getLogger(__name__)

_FRAME_URL = "{base}/api/xbrl/frames/{taxonomy}/{concept}/shares/{period}.json"
_QUARTERS_BACK = 4  # 8 bulk requests a day in total
_MIN_COMPLETE = 3000  # a complete set of frames covers ~6,000 filers


def recent_quarters(today: date, count: int) -> list[tuple[int, int]]:
    """The `count` calendar quarters before the current one, newest first: [(2026, 3), (2026, 2), …]."""
    year, quarter = today.year, (today.month - 1) // 3 + 1
    out = []
    for _ in range(count):
        quarter -= 1
        if quarter == 0:
            year, quarter = year - 1, 4
        out.append((year, quarter))
    return out


class MarketCaps:
    def __init__(self, sec: SecEdgarClient, quotes: QuoteService):
        self.sec = sec
        self.quotes = quotes
        self._cache = TTLCache(24 * 60 * 60)
        self._lock = asyncio.Lock()

    async def _frame(self, taxonomy: str, concept: str, period: str) -> dict[int, tuple[str, float]]:
        url = _FRAME_URL.format(base=self.sec.settings.sec_data_base_url, taxonomy=taxonomy, concept=concept, period=period)
        try:
            data = await self.sec._get_json(url, cache=False)
        except SecApiError as exc:
            if exc.status_code != 404:  # 404 = a quarter with no filings yet
                logger.warning("SEC frame %s/%s/%s unavailable: %s", taxonomy, concept, period, exc)
            return {}
        return {int(r["cik"]): (r["end"], float(r["val"])) for r in data.get("data", []) if r.get("val")}

    async def shares_by_cik(self) -> dict[int, float]:
        """{CIK: latest shares outstanding} for every SEC filer (cached a day)."""
        async with self._lock:
            cached = self._cache.get("shares")
            if cached is not None:
                return cached
            quarters = recent_quarters(date.today(), _QUARTERS_BACK)
            # Oldest first, so newer frames overwrite older values.
            diluted: dict[int, tuple[str, float]] = {}
            for y, q in reversed(quarters):
                diluted.update(await self._frame("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", f"CY{y}Q{q}"))
            cover: dict[int, tuple[str, float]] = {}
            for y, q in reversed(quarters):
                cover.update(await self._frame("dei", "EntityCommonStockSharesOutstanding", f"CY{y}Q{q}I"))
            shares = {cik: v for cik, (_, v) in diluted.items()}
            shares.update({cik: v for cik, (_, v) in cover.items()})
            # A failed or throttled frame leaves a partial map: use it, but try again on the next request.
            if len(shares) >= _MIN_COMPLETE:
                self._cache.set("shares", shares)
            return shares

    async def usd_rate(self, currency: str) -> float | None:
        """Units of USD per unit of `currency`, from Yahoo FX (cached with the quote cache)."""
        if currency == "USD":
            return 1.0
        snap = await self.quotes.get_snapshot(f"{currency}USD=X")
        return snap.price if snap and snap.price > 0 else None
