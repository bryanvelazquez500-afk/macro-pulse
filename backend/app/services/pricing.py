"""Share price for valuation, plus whether it can be compared with the filings' per-share figures."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.financials_service import FinancialsService, LoadedFinancials
from app.services.gaap_mapping import Metric, NormalizedPeriod
from app.services.listings import US_ORDINARY_SHARE_LISTINGS
from app.services.quotes import Quote, QuoteService


@dataclass(frozen=True)
class PriceContext:
    """A quote plus whether it can be compared with the filings' per-share figures."""

    quote: Quote | None
    comparable: bool
    note: str | None = None


_FOREIGN_ANNUAL_FORMS = {"20-F", "20-F/A", "40-F", "40-F/A"}


def is_foreign_filer(p: NormalizedPeriod) -> bool:
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
        quote, loaded.currency, priced_us_listing=route.listing is None and symbol not in US_ORDINARY_SHARE_LISTINGS, foreign_filer=bool(latest and is_foreign_filer(latest))
    )


def spinoff_after(splits: list[tuple[str, float]], filed: str | None) -> str | None:
    """Date of a spin-off (a non-split price-adjustment factor in the split record) after `filed`, if any.

    After a spin-off the share price covers only the remaining company while the latest filing still
    describes the combined one, so per-share comparisons wait for the next filing.
    """
    from app.services.gaap_mapping import _split_like

    if not filed:
        return None
    return next((day for day, ratio in splits if day > filed and abs(ratio - 1) > 0.005 and not _split_like(ratio)), None)


def spinoff_context(price: PriceContext, day: str) -> PriceContext:
    return PriceContext(
        price.quote,
        False,
        f"Price not comparable: a spin-off/separation on {day} came after the latest filing — the price is for the "
        "post-separation company, the filings still for the combined one",
    )
