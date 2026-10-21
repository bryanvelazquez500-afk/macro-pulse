"""The US stock universe: every company listed on a US exchange (NYSE, Nasdaq, Cboe) that files with the SEC.

Built offline by `scripts/build_us_universe.py` from two SEC bulk files — the exchange ticker list
(company_tickers_exchange.json) and the company profiles (submissions.zip, for each company's SIC
industry code and business address) — and saved to data/us_universe.json, so the site never needs
thousands of per-company SEC requests. Rebuild it occasionally to pick up new listings.

Sectors are GICS-style groups derived from the SEC's SIC industry codes (`sector_for_sic`); the curated
scout lists override them where a company's SIC code misleads (Alphabet is SIC 7370 "computer services"
but Communication Services in GICS).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

UNIVERSE_PATH = Path(__file__).resolve().parents[2] / "data" / "us_universe.json"

T, F, H, CD, CS, E, I, M, C, U, R = (
    "Technology", "Financials", "Healthcare", "Consumer Discretionary", "Consumer Staples", "Energy",
    "Industrials", "Materials", "Communication Services", "Utilities", "Real Estate",
)  # fmt: skip

# (first SIC, last SIC, sector) — the first matching range wins, so specific ranges come before broad ones.
_SIC_SECTORS: list[tuple[int, int, str]] = [
    (100, 999, CS),  # agriculture
    (1000, 1099, M), (1200, 1299, E), (1300, 1399, E), (1400, 1499, M),  # mining, oil & gas
    (1531, 1531, CD), (1500, 1799, I),  # homebuilders; construction
    (2000, 2199, CS),  # food, beverages, tobacco
    (2200, 2399, CD),  # textiles, apparel
    (2400, 2499, M), (2500, 2599, CD), (2600, 2699, M), (2700, 2799, C),  # lumber, furniture, paper, publishing
    (2830, 2836, H), (2840, 2844, CS), (2800, 2899, M),  # pharma; household & personal care; chemicals
    (2900, 2999, E),  # petroleum refining
    (3000, 3099, M), (3100, 3199, CD), (3200, 3399, M), (3400, 3499, I),
    (3570, 3579, T), (3500, 3599, I),  # computers; machinery
    (3630, 3639, CD), (3651, 3652, CD), (3660, 3679, T), (3600, 3699, I),  # appliances, consumer AV; telecom gear & semis; electrical equipment
    (3711, 3716, CD), (3751, 3751, CD), (3700, 3799, I),  # autos & parts, motorcycles; aerospace & transport equipment
    (3840, 3851, H), (3820, 3829, T), (3860, 3861, T), (3800, 3899, I),  # medical devices; instruments
    (3900, 3999, CD),  # toys, jewelry, sporting goods
    (4810, 4899, C), (4950, 4959, I), (4900, 4999, U), (4000, 4799, I),  # telecom & media; waste; utilities; transport
    (5120, 5122, H), (5140, 5149, CS), (5000, 5199, I),  # drug & grocery wholesale; other wholesale
    (5310, 5399, CS), (5400, 5499, CS), (5912, 5912, CS), (5200, 5999, CD),  # mass merchants, grocers, drugstores; other retail
    (6500, 6553, R), (6798, 6798, R), (6000, 6799, F),  # real estate & REITs; finance
    (7310, 7319, C), (7370, 7379, T), (7000, 7299, CD), (7300, 7399, I),  # advertising; software & IT; hotels, personal services; business services
    (7500, 7599, CD), (7800, 7899, C), (7900, 7999, CD),  # auto services; film & TV; entertainment
    (8000, 8099, H), (8731, 8731, H), (8200, 8299, CD), (8700, 8799, I), (8000, 8999, I),
]  # fmt: skip

# Not operating companies: blank-check shells (6770), commodity pools and trusts (6221, 6792), non-operating (9995).
EXCLUDED_SIC = {6770, 6221, 6792, 9995, 6189}


def sector_for_sic(sic: int | None) -> str | None:
    if sic is None:
        return None
    return next((sector for lo, hi, sector in _SIC_SECTORS if lo <= sic <= hi), None)


@dataclass(frozen=True)
class Listing:
    ticker: str
    cik: int
    name: str
    exchange: str
    sic: int | None
    sector: str


@lru_cache(maxsize=1)
def _load(mtime: float) -> tuple[Listing, ...]:  # keyed by mtime: a rebuilt file is picked up
    raw = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
    return tuple(Listing(**row) for row in raw["listings"])


def us_listings() -> tuple[Listing, ...]:
    try:
        return _load(UNIVERSE_PATH.stat().st_mtime)
    except OSError:
        return ()


def search(query: str, limit: int = 10) -> list[Listing]:
    """Ticker prefix matches first, then names containing the query (case-insensitive)."""
    q = query.strip().upper()
    if not q:
        return []
    listings = us_listings()
    exact = [l for l in listings if l.ticker == q]
    prefix = [l for l in listings if l.ticker.startswith(q) and l.ticker != q]
    words = re.compile(r"\b" + re.escape(q), re.IGNORECASE)
    named = [l for l in listings if not l.ticker.startswith(q) and words.search(l.name)]
    return (exact + sorted(prefix, key=lambda l: (len(l.ticker), l.ticker)) + named)[:limit]
