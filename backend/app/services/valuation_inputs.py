"""Market inputs for the Intrinsic Valuation Station: price, sector beta and the active macro factors.

The statement-driven parts of each model (FCF, EPS, dividends, shares) come from the financials
endpoint the frontend already holds, so its sliders can re-price instantly; this supplies what the
filings can't.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.pricing import PriceContext, resolve_price
from app.services.data_router import DataSource
from app.services.financials_service import FinancialsService
from app.services.gaap_mapping import PeriodType
from app.services.macro_rates import MacroFactors, SectorBeta, load_macro_factors
from app.services.peers import PEER_GROUPS, match_peer_group
from app.services.quotes import QuoteService


@dataclass(frozen=True)
class BetaChoice:
    value: float
    group_key: str  # peers.PEER_GROUPS key, or "market"
    group_label: str
    basis: str  # how the group was chosen: "ticker" | "sic" | "sic_major_group" | "market (no SEC industry code)" …
    source: str


@dataclass(frozen=True)
class ValuationInputs:
    symbol: str
    currency: str
    price: PriceContext
    beta: BetaChoice
    factors: MacroFactors


def choose_beta(factors: MacroFactors, group_key: str | None, basis: str) -> BetaChoice:
    key = group_key if group_key in factors.sector_betas else "market"
    beta: SectorBeta = factors.sector_betas[key]
    label = PEER_GROUPS[key].label if key in PEER_GROUPS else "Total market"
    return BetaChoice(beta.beta, key, label, basis if key == group_key else f"market ({basis})", factors.sector_betas_source)


async def get_valuation_inputs(financials: FinancialsService, quotes: QuoteService, identifier: str) -> ValuationInputs:
    loaded = await financials.load_periods(identifier, PeriodType.ANNUAL)
    symbol, price = await resolve_price(financials, quotes, loaded)
    factors = load_macro_factors()

    group_key, basis = None, "no SEC industry code"
    if loaded.route.source is DataSource.SEC:
        sub = await financials.sec.get_submissions(loaded.route.cik)
        tickers = [t.upper() for t in sub.get("tickers", [])]
        if match := match_peer_group(tickers[0] if tickers else None, str(sub.get("sic") or "") or None):
            group_key, basis = match.group_key, match.basis
        else:
            basis = "industry code not mapped to a peer group"
    return ValuationInputs(symbol, loaded.currency, price, choose_beta(factors, group_key, basis), factors)
