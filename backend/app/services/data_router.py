"""Dual-pipeline routing: decides whether a symbol is served from SEC EDGAR or the global provider.

  TSLA, BRK.B, 320193 ─────────────────────────────► SEC EDGAR (10-K/10-Q, US GAAP)
  ASML.AS, VOD.L, 7203.T ─► SEC registrant found? ─► SEC EDGAR (20-F/40-F, IFRS or US GAAP, home currency)
                                    └── no ────────► Financial Modeling Prep (standardized statements)

SEC data is preferred whenever a foreign company files there: it's free, official, and carries
full history, where FMP's free plan excludes non-US listings entirely.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from app.services.listings import Listing, parse_listing, sec_ticker_candidate
from app.services.sec_client import CompanyNotFoundError, SecEdgarClient

# Forms only foreign private issuers file; a registrant with any of them is a foreign company.
_FOREIGN_ISSUER_FORMS = {"20-F", "20-F/A", "40-F", "40-F/A", "6-K"}


class DataSource(StrEnum):
    SEC = "sec"
    FMP = "fmp"


@dataclass(frozen=True)
class Route:
    source: DataSource
    symbol: str  # what the user asked for, normalized: "ASML.AS", "AAPL"
    cik: int | None = None  # set when source is SEC
    listing: Listing | None = None  # set for international symbols


def _country_codes(submissions: dict[str, Any]) -> set[str]:
    # Mailing addresses are skipped: foreign filers often use a US agent's (MUFG, Rio Tinto → NY).
    business = submissions.get("addresses", {}).get("business", {}) or {}
    return {c for c in (submissions.get("stateOfIncorporation"), business.get("stateOrCountry")) if c}


def is_registrant_for(listing: Listing, submissions: dict[str, Any]) -> bool:
    """Whether an EDGAR registrant found by symbol is plausibly the company listed abroad.

    Its incorporation or business country must be the exchange's country. When EDGAR records
    neither (common for 20-F filers), it must at least be a foreign private issuer.
    """
    codes = _country_codes(submissions)
    if codes:
        return bool(codes & listing.exchange.edgar_codes)
    return bool(_FOREIGN_ISSUER_FORMS & set(submissions.get("filings", {}).get("recent", {}).get("form", [])))


class DataRouter:
    def __init__(self, sec: SecEdgarClient):
        self.sec = sec

    async def resolve(self, identifier: str) -> Route:
        symbol = identifier.strip().upper()
        listing = parse_listing(symbol)
        if listing is None:
            return Route(DataSource.SEC, symbol, cik=await self.sec.resolve_cik(symbol))
        cik = await self._sec_registrant(listing)
        if cik is not None:
            return Route(DataSource.SEC, listing.symbol, cik=cik, listing=listing)
        return Route(DataSource.FMP, listing.symbol, listing=listing)

    async def _sec_registrant(self, listing: Listing) -> int | None:
        candidate = sec_ticker_candidate(listing)
        if candidate is None:
            return None
        ticker, curated = candidate
        match = (await self.sec.get_ticker_map()).get(ticker)
        if match is None:
            return None
        if curated:
            return match["cik"]
        try:
            submissions = await self.sec.get_submissions(match["cik"])
        except CompanyNotFoundError:
            return None
        return match["cik"] if is_registrant_for(listing, submissions) else None
