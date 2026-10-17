"""GuruFocus-style earnings DCF, server side — for lists of companies (Equity Discovery).

Same model as frontend/src/lib/gurufocusDcf.ts (kept in step by a shared test vector in
tests/test_gurufocus.py):

    Fair value = EPS·x(1 − x¹⁰)/(1 − x) + EPS·x¹⁰·y(1 − y¹⁰)/(1 − y) + tangible book value per share
    x = (1 + g₁)/(1 + d),  y = (1 + 4%)/(1 + d),  d = 10-year Treasury + 6%
    g₁ = historical 10-year diluted-EPS CAGR (5- or 3-year fallback)

Results are cached per company for six hours; the underlying CompanyFacts are deliberately *not*
cached (a long country list would otherwise hold gigabytes of parsed filings).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.checklist_service import resolve_price
from app.services.data_router import DataSource
from app.services.financials_service import FinancialsService
from app.services.fmp_client import API_KEY_REQUIRED, FmpError
from app.services.gaap_mapping import Metric, NormalizedPeriod, PeriodType
from app.services.macro_rates import load_macro_factors
from app.services.quotes import QuoteService
from app.services.sec_client import SecApiError, TTLCache

GROWTH_YEARS = 10
TERMINAL_YEARS = 10
TERMINAL_GROWTH = 0.04
EQUITY_RISK_PREMIUM = 0.06


@dataclass(frozen=True)
class GuruFocusDcf:
    symbol: str
    status: str  # "ok" | "na"
    reason: str | None = None
    code: str | None = None  # "api_key_required" when the missing piece is an API key / paid plan
    currency: str | None = None  # reporting currency of the fair value
    fair_value: float | None = None
    growth_stage: float | None = None
    terminal_stage: float | None = None
    tangible_book_per_share: float | None = None
    eps: float | None = None
    eps_year: int | None = None
    growth_rate: float | None = None
    growth_years: int | None = None
    discount_rate: float | None = None
    price: float | None = None
    price_currency: str | None = None
    margin_of_safety: float | None = None  # (fair value − price) ÷ fair value; None when price isn't comparable
    price_note: str | None = None


def _v(p: NormalizedPeriod, m: Metric) -> float | None:
    item = p.values.get(m)
    return item.value if item else None


def diluted_eps(p: NormalizedPeriod) -> float | None:
    ni, shares = _v(p, Metric.NET_INCOME), _v(p, Metric.DILUTED_SHARES)
    return ni / shares if ni is not None and shares else None


def historical_eps_growth(annual: list[NormalizedPeriod]) -> tuple[float, int] | None:
    latest = next((p for p in annual if p.fiscal_year is not None and diluted_eps(p) is not None), None)
    if latest is None or diluted_eps(latest) <= 0:
        return None
    for years in (10, 5, 3):
        base = next((p for p in annual if p.fiscal_year == latest.fiscal_year - years), None)
        eps_then = diluted_eps(base) if base else None
        if eps_then is not None and eps_then > 0:
            return (diluted_eps(latest) / eps_then) ** (1 / years) - 1, years
    return None


def _geometric_sum(r: float, n: int) -> float:
    return n if abs(r - 1) < 1e-12 else r * (1 - r**n) / (1 - r)


def fair_value(eps: float, growth: float, discount: float, tangible_book_per_share: float) -> tuple[float, float, float]:
    """(fair value, growth-stage value, terminal-stage value)."""
    x = (1 + growth) / (1 + discount)
    y = (1 + TERMINAL_GROWTH) / (1 + discount)
    growth_stage = eps * _geometric_sum(x, GROWTH_YEARS)
    terminal_stage = eps * x**GROWTH_YEARS * _geometric_sum(y, TERMINAL_YEARS)
    return growth_stage + terminal_stage + tangible_book_per_share, growth_stage, terminal_stage


class GuruFocusService:
    def __init__(self, financials: FinancialsService, quotes: QuoteService):
        self.financials = financials
        self.quotes = quotes
        self._cache = TTLCache(6 * 60 * 60)

    async def evaluate(self, identifier: str) -> GuruFocusDcf:
        symbol = identifier.strip().upper()
        rf = load_macro_factors().risk_free_rate.value
        key = f"{symbol}:{rf}"
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        result = await self._evaluate(symbol, rf)
        self._cache.set(key, result)
        return result

    async def _evaluate(self, symbol: str, rf: float) -> GuruFocusDcf:
        try:
            route = await self.financials.router.resolve(symbol)
            if route.source is DataSource.FMP and not self.financials.fmp.configured:
                return GuruFocusDcf(symbol, "na", "Not an SEC registrant — needs an FMP key for statements", API_KEY_REQUIRED)
            loaded = await self.financials.load_periods(symbol, PeriodType.ANNUAL, cache_facts=False)
        except (SecApiError, FmpError) as exc:
            return GuruFocusDcf(symbol, "na", str(exc), getattr(exc, "code", None))

        annual = loaded.periods
        latest = annual[0] if annual else None
        eps = diluted_eps(latest) if latest else None
        if eps is None:
            return GuruFocusDcf(symbol, "na", "Net income or diluted shares not reported")
        if eps <= 0:
            return GuruFocusDcf(symbol, "na", "Loss-making — needs positive EPS")
        growth = historical_eps_growth(annual)
        if growth is None:
            return GuruFocusDcf(symbol, "na", "Needs positive EPS at least 3 years apart")

        shares = _v(latest, Metric.DILUTED_SHARES)
        equity = _v(latest, Metric.STOCKHOLDERS_EQUITY)
        tbv = (equity - (_v(latest, Metric.GOODWILL_AND_INTANGIBLES) or 0)) / shares if equity is not None else 0.0
        d = rf + EQUITY_RISK_PREMIUM
        value, growth_stage, terminal_stage = fair_value(eps, growth[0], d, tbv)

        _, price = await resolve_price(self.financials, self.quotes, loaded)
        q = price.quote
        mos = (value - q.price) / value if q and price.comparable and value > 0 else None
        return GuruFocusDcf(
            symbol=symbol,
            status="ok",
            currency=loaded.currency,
            fair_value=value,
            growth_stage=growth_stage,
            terminal_stage=terminal_stage,
            tangible_book_per_share=tbv,
            eps=eps,
            eps_year=latest.fiscal_year,
            growth_rate=growth[0],
            growth_years=growth[1],
            discount_rate=d,
            price=q.price if q else None,
            price_currency=q.currency if q else None,
            margin_of_safety=mos,
            price_note=price.note,
        )
