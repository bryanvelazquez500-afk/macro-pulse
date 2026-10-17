"""Builds the Legend Investment Checklist for a company: annual history + a comparable share price."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.financials_service import FinancialsService, LoadedFinancials
from app.services.gaap_mapping import Metric, NormalizedPeriod, PeriodType
from app.services.quotes import Quote, QuoteService
from app.services.vetting import InvestorChecklist, PriceContext, evaluate

_FOREIGN_ANNUAL_FORMS = {"20-F", "20-F/A", "40-F", "40-F/A"}


@dataclass(frozen=True)
class Checklist:
    symbol: str
    entity_name: str
    fiscal_year: int | None
    period_end: str | None
    currency: str
    price: PriceContext
    investors: list[InvestorChecklist]


def _is_foreign_filer(p: NormalizedPeriod) -> bool:
    item = p.values.get(Metric.REVENUE) or p.values.get(Metric.NET_INCOME)
    return item is not None and item.form in _FOREIGN_ANNUAL_FORMS


def price_context(quote: Quote | None, currency: str, priced_us_listing: bool, foreign_filer: bool) -> PriceContext:
    if quote is None:
        return PriceContext(None, False, "No share price available (FMP key not set and Yahoo Finance didn't respond)")
    if foreign_filer and priced_us_listing:
        return PriceContext(
            quote, False,
            "Priced via a US depositary receipt, which can represent several ordinary shares — "
            "look up the home listing (e.g. ASML.AS, VOD.L) for P/E-based checks",
        )  # fmt: skip
    if quote.currency != currency:
        return PriceContext(quote, False, f"Price is in {quote.currency} but the financials are reported in {currency}")
    return PriceContext(quote, True)


async def resolve_price(financials: FinancialsService, quotes: QuoteService, loaded: LoadedFinancials) -> tuple[str, PriceContext]:
    """(symbol priced, price + whether it's comparable with the filings' per-share figures)."""
    route, latest = loaded.route, (loaded.periods[0] if loaded.periods else None)
    # Price the listing the user asked for; CIK lookups fall back to the primary US ticker.
    symbol = route.symbol
    if symbol.isdigit():
        tickers = (await financials.sec.get_submissions(route.cik)).get("tickers", [])
        symbol = tickers[0] if tickers else symbol
    quote = await quotes.get_quote(symbol) if not symbol.isdigit() else None
    return symbol, price_context(
        quote, loaded.currency, priced_us_listing=route.listing is None, foreign_filer=bool(latest and _is_foreign_filer(latest))
    )


class ChecklistService:
    def __init__(self, financials: FinancialsService, quotes: QuoteService):
        self.financials = financials
        self.quotes = quotes

    async def get_checklist(self, identifier: str) -> Checklist:
        loaded = await self.financials.load_periods(identifier, PeriodType.ANNUAL)
        route, periods = loaded.route, loaded.periods
        latest = periods[0] if periods else None

        symbol, price = await resolve_price(self.financials, self.quotes, loaded)
        return Checklist(
            symbol=symbol,
            entity_name=loaded.entity_name,
            fiscal_year=latest.fiscal_year if latest else None,
            period_end=latest.end if latest else None,
            currency=loaded.currency,
            price=price,
            investors=evaluate(periods, price, loaded.currency),
        )
