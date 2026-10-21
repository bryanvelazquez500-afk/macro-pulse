"""Live market capitalization for the scout lists: price × shares outstanding.

Shares come from SEC EDGAR's XBRL "frames" API, which returns one concept for every filer in a single
call: quarterly diluted weighted-average shares (all share classes), falling back to the cover-page
`dei:EntityCommonStockSharesOutstanding` for filers without US-GAAP share facts.
A handful of requests covers every SEC registrant, so ranking a 200-stock list needs no per-company filings.

Companies that aren't SEC registrants have no free share count, so they have no market cap and rank
after those that do. US depositary receipts (other than 1:1 listings) are skipped: their price is for
a bundle of shares, so price × ordinary shares would be wrong.
"""

from __future__ import annotations

import asyncio
import math
import logging
from datetime import date

from app.services.gaap_mapping import _scale_like
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


def _unit_gap(ratio: float) -> bool:
    """Within ±40% of a power of 1,000 (counts at different dates differ a little, units by ×1,000)."""
    exponent = round(math.log10(ratio) / 3) * 3 if ratio > 0 else 0
    return exponent != 0 and 0.7 <= ratio / 10**exponent <= 1.4


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
            # Diluted weighted shares cover every share class (Mobileye's Class B, Alphabet's three classes) and
            # aren't subject to cover-page slips (Alibaba's 2026 cover states 1.86B for ~18.6B shares); the
            # cover page fills in for filers without US-GAAP share facts (IFRS 20-F/40-F filers).
            shares = {cik: v for cik, (_, v) in cover.items()}
            for cik, (_, v) in diluted.items():
                c = shares.get(cik)
                # The two counts disagreeing by ~×1,000 / ×1,000,000 means one was tagged in the wrong unit
                # (McDonald's diluted "716.4"; Aeluma's diluted 18 billion vs 19 million on its cover):
                # the cover page — a plain share count — wins.
                if v < 100_000 or (c and _unit_gap(c / v)):
                    continue
                shares[cik] = v
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
