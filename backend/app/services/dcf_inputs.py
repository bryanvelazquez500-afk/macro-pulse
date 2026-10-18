"""Live inputs for the two-stage DCF calculator, per ticker, from the existing data pipelines.

  SEC EDGAR (US filers and foreign 20-F/40-F filers) ── CompanyFacts XBRL
      · trailing twelve months = last fiscal year + current year-to-date − prior year-to-date
        (10-Qs report cash flows year-to-date, so this is the only way to get a cash-flow TTM)
      · 20-F/40-F filers publish no quarterly XBRL, so their "TTM" is the latest fiscal year (flagged)
  Financial Modeling Prep (other listings, needs FMP_API_KEY) ── annual statements, latest fiscal year
  Yahoo Finance / FMP ── price;  Yahoo FX (e.g. EURUSD=X) ── converts per-share figures into the
      price's currency when a home listing trades in a different currency from the filings
  macro_factors.json ── 10-year Treasury yield

What the filings can't provide is reported in `missing` rather than invented: GuruFocus's "EPS without
NRI" (non-recurring items stripped by GuruFocus analysts) and its Business Predictability Rating.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Any

from app.services.pricing import is_foreign_filer, price_context
from app.services.data_router import DataSource
from app.services.financials_service import FinancialsService
from app.services.fmp_client import FmpNotConfiguredError
from app.services.fmp_mapping import normalize_fmp_statements
from app.services.gaap_mapping import (
    Metric,
    NormalizedPeriod,
    PeriodType,
    _ANNUAL_FORMS,
    _QUARTERLY_FORMS,
    _unit_facts,
    detect_reporting_basis,
    normalize_balance_sheets,
    normalize_company_facts,
    ordered_tag_maps,
)
from app.services.listings import US_ORDINARY_SHARE_LISTINGS
from app.services.macro_rates import load_macro_factors
from app.services.quotes import Quote, QuoteService
from app.services.sec_client import TTLCache

BASES = {
    "eps": "EPS (diluted, GAAP)",
    "fcf": "Free cash flow per share",
    "dividend": "Dividend per share",
}

MISSING_ALWAYS = [
    "EPS without NRI — GuruFocus strips non-recurring items by hand; SEC filings only give GAAP diluted EPS, which is used instead",
    "Business Predictability Rating — a GuruFocus score with no equivalent in SEC filings or your data providers",
]


@dataclass(frozen=True)
class BasisInput:
    key: str  # "eps" | "fcf" | "dividend"
    label: str
    value: float | None  # per share, in DcfInputs.currency
    period: str | None  # "TTM to 2026-06-27" | "FY2025"
    is_ttm: bool
    h10: float | None  # historical growth, percent per year
    h10_years: int | None  # span actually measured: 10, else 5 or 3
    h10_note: str | None = None


@dataclass(frozen=True)
class DcfInputs:
    symbol: str
    name: str
    source: str  # "SEC EDGAR" | "Financial Modeling Prep"
    currency: str  # currency of every per-share figure below (the price's, after any FX conversion)
    reporting_currency: str
    fx_rate: float | None  # reporting → price currency, when converted
    price: float | None
    price_source: str | None
    price_as_of: str | None
    price_comparable: bool
    price_note: str | None
    bases: list[BasisInput]
    tbv: float | None
    tbv_as_of: str | None
    shares: float | None  # diluted weighted-average shares behind the per-share figures
    t10: float  # 10-year Treasury yield, percent
    t10_as_of: str
    t10_source: str
    predictability: float | None = None  # 0–5 stars; no source available
    missing: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Fundamentals:
    """Everything except the price, cached per symbol (6h): in the reporting currency."""

    route_symbol: str
    us_listing: bool
    foreign_filer: bool
    name: str
    source: str
    currency: str
    bases: list[BasisInput]
    tbv: float | None
    tbv_as_of: str | None
    shares: float | None
    notes: list[str]


# ---------------------------------------------------------------- TTM from raw XBRL facts

_ANNUAL_DAYS = range(350, 380)


def _d(s: str) -> date:
    return date.fromisoformat(s)


def _days(f: dict[str, Any]) -> int:
    return (_d(f["end"]) - _d(f["start"])).days


def _newest(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return max(facts, key=lambda f: (f["end"], f.get("filed", "")))


def ttm_value(company_facts: dict[str, Any], tags: list[str], unit: str) -> tuple[float, str, bool] | None:
    """(value, period end, is_ttm) for a duration metric: FY + YTD − prior YTD, else the latest FY.

    Tags are tried in priority order; the one reaching the latest period wins (companies switch tags).
    """
    best: tuple[float, str, bool] | None = None
    for tag in tags:
        facts = [
            f
            for f in _unit_facts(company_facts, tag, unit)
            if f.get("start") and f.get("end") and f.get("form") in _ANNUAL_FORMS | _QUARTERLY_FORMS
        ]
        annual = [f for f in facts if _days(f) in _ANNUAL_DAYS and f["form"] in _ANNUAL_FORMS]
        if not annual:
            continue
        fy = _newest(annual)
        fy_end = _d(fy["end"])
        ytd = [
            f
            for f in facts
            if f["form"] in _QUARTERLY_FORMS
            and abs((_d(f["start"]) - (fy_end + timedelta(days=1))).days) <= 7
            and _d(f["end"]) > fy_end
            and 80 <= _days(f) <= 300
        ]
        candidate: tuple[float, str, bool] = (float(fy["val"]), fy["end"], False)
        if ytd:
            cur = _newest(ytd)
            target_end = _d(cur["end"]) - timedelta(days=365)
            prior = [
                f
                for f in facts
                if abs(_days(f) - _days(cur)) <= 10 and abs((_d(f["end"]) - target_end).days) <= 10
            ]
            if prior:
                # The most recently filed figure picks up restatements.
                prev = max(prior, key=lambda f: f.get("filed", ""))
                candidate = (float(fy["val"]) + float(cur["val"]) - float(prev["val"]), cur["end"], True)
        if best is None or candidate[1] > best[1]:
            best = candidate
    return best


def latest_shares(company_facts: dict[str, Any], tags: list[str]) -> tuple[float, str] | None:
    """Most recent diluted weighted-average share count (any quarterly or annual period)."""
    facts = [
        f
        for tag in tags
        for f in _unit_facts(company_facts, tag, "shares")
        if f.get("start") and f.get("end") and f.get("form") in _ANNUAL_FORMS | _QUARTERLY_FORMS and f.get("val")
    ]
    if not facts:
        return None
    f = _newest(facts)
    return float(f["val"]), f["end"]


# ---------------------------------------------------------------- history (H10)


def _v(p: NormalizedPeriod, m: Metric) -> float | None:
    item = p.values.get(m)
    return item.value if item else None


def _split_like(ratio: float, tolerance: float) -> float | None:
    """The split factor a share-count ratio looks like (2-for-1, 3-for-2, 1-for-10…), if any."""
    for r, inverse in ((ratio, False), (1 / ratio, True)):
        nearest = 1.5 if abs(r - 1.5) / 1.5 <= tolerance else round(r)
        if nearest >= 1.5 and abs(r - nearest) / nearest <= tolerance:
            return 1 / nearest if inverse else nearest
    return None


EPS_DILUTED_TAGS = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "ifrs-full:DilutedEarningsLossPerShare",
    "ifrs-full:BasicAndDilutedEarningsLossPerShare",
]
# When no diluted count is tagged (Exxon, Honda, TotalEnergies): basic weighted-average shares.
BASIC_SHARE_TAGS = [
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
    "ifrs-full:WeightedAverageShares",
]


def annual_shares(annual: list[NormalizedPeriod], company_facts: dict[str, Any] | None, currency: str) -> dict[int, float]:
    """{id(period): diluted shares on today's share basis}.

    Gaps are filled with net income ÷ reported diluted EPS (Alphabet tags its share counts per class only).
    Splits the normalizer didn't restate are then caught as a share-count jump matching a split ratio
    (Toyota's 2021 5-for-1 split sits across its US GAAP → IFRS switch, so no filing restates it).
    """
    eps_by_period: dict[tuple[str, str], dict[str, Any]] = {}
    if company_facts is not None:
        for tag in EPS_DILUTED_TAGS:
            for f in _unit_facts(company_facts, tag, f"{currency}/shares"):
                if f.get("start") and f.get("end") and f.get("form") in _ANNUAL_FORMS and f.get("val"):
                    key = (f["start"], f["end"])
                    if key not in eps_by_period or f.get("filed", "") > eps_by_period[key].get("filed", ""):
                        eps_by_period[key] = f
    raw: list[tuple[NormalizedPeriod, float]] = []
    for p in sorted(annual, key=lambda p: p.end):
        shares = _v(p, Metric.DILUTED_SHARES)
        ni, eps = _v(p, Metric.NET_INCOME), eps_by_period.get(p.key)
        if not shares and ni and eps and float(eps["val"]) != 0 and ni / float(eps["val"]) > 0:
            shares = ni / float(eps["val"])
        if shares:
            raw.append((p, shares))
    adjusted: dict[int, float] = {}
    cumulative = 1.0
    for i in range(len(raw) - 1, -1, -1):
        p, shares = raw[i]
        if i < len(raw) - 1:
            newer, newer_shares = raw[i + 1]
            gap = max(1, round((date.fromisoformat(newer.end) - date.fromisoformat(p.end)).days / 365))
            if (split := _split_like(newer_shares / shares, min(0.10, 0.03 + 0.02 * (gap - 1)))) is not None:
                cumulative *= split
        adjusted[id(p)] = shares * cumulative
    return adjusted


def _per_share(p: NormalizedPeriod, key: str, shares: float | None = None) -> float | None:
    shares = shares or _v(p, Metric.DILUTED_SHARES)
    if not shares:
        return None
    if key == "eps":
        ni = _v(p, Metric.NET_INCOME)
        return ni / shares if ni is not None else None
    if key == "fcf":
        fcf = _v(p, Metric.FREE_CASH_FLOW)
        return fcf / shares if fcf is not None else None
    div = _v(p, Metric.DIVIDENDS_PAID)
    return abs(div) / shares if div is not None else None


def historical_growth(
    annual: list[NormalizedPeriod], key: str, shares: dict[int, float] | None = None
) -> tuple[float | None, int | None, str | None]:
    """(percent CAGR, years, note): 10 years when both ends are positive, else 5, else 3."""
    shares = shares if shares is not None else annual_shares(annual, None, "")
    latest = next((p for p in annual if p.fiscal_year is not None and _per_share(p, key, shares.get(id(p))) is not None), None)
    if latest is None:
        return None, None, "No annual history"
    to_value = _per_share(latest, key, shares.get(id(latest)))
    if to_value <= 0:
        return None, None, "Latest annual value is zero or negative, so growth can't be measured"
    for years in (10, 5, 3):
        base = next((p for p in annual if p.fiscal_year == latest.fiscal_year - years), None)
        from_value = _per_share(base, key, shares.get(id(base))) if base else None
        if from_value is not None and from_value > 0:
            note = None if years == 10 else f"{years}-year growth — 10 years of positive values aren't available"
            return ((to_value / from_value) ** (1 / years) - 1) * 100, years, note
    return None, None, "Needs positive values at least 3 years apart"


# ---------------------------------------------------------------- service


class DcfInputsService:
    def __init__(self, financials: FinancialsService, quotes: QuoteService):
        self.financials = financials
        self.quotes = quotes
        self._cache = TTLCache(6 * 60 * 60)

    async def get(self, identifier: str, cache_facts: bool = True) -> DcfInputs:
        symbol = identifier.strip().upper()
        fundamentals = self._cache.get(symbol)
        if fundamentals is None:
            fundamentals = await self._fundamentals(symbol, cache_facts)
            self._cache.set(symbol, fundamentals)
        return await self._with_price(fundamentals)

    async def quote(self, identifier: str) -> Quote | None:
        return await self.quotes.get_quote(identifier.strip().upper())

    async def _fundamentals(self, symbol: str, cache_facts: bool) -> _Fundamentals:
        route = await self.financials.router.resolve(symbol)
        if route.source is DataSource.FMP:
            if not self.financials.fmp.configured:
                raise FmpNotConfiguredError(symbol)
            return await self._from_fmp(route.symbol)

        facts = await self.financials.sec.get_company_facts(route.cik, cache=cache_facts)
        basis = detect_reporting_basis(facts)
        annual = normalize_company_facts(facts, PeriodType.ANNUAL, basis)
        durations = ordered_tag_maps(basis)[0]
        notes: list[str] = []

        def ttm(metric: Metric) -> tuple[float, str, bool] | None:
            return ttm_value(facts, durations[metric], basis.currency)

        ni, ocf, capex, div = ttm(Metric.NET_INCOME), ttm(Metric.OPERATING_CASH_FLOW), ttm(Metric.CAPITAL_EXPENDITURES), ttm(Metric.DIVIDENDS_PAID)
        shares = self._shares(facts, durations[Metric.DILUTED_SHARES], annual, basis.currency, ni[1] if ni else None)

        history_shares = annual_shares(annual, facts, basis.currency)

        def basis_input(key: str, total: float | None, end: str | None, is_ttm: bool) -> BasisInput:
            h10, years, note = historical_growth(annual, key, history_shares)
            value = total / shares if total is not None and shares else None
            period = None if end is None else (f"TTM to {end}" if is_ttm else f"FY ending {end}")
            return BasisInput(key, BASES[key], value, period, is_ttm, h10, years, note)

        fcf_parts = ocf and capex and ocf[1] == capex[1]
        bases = [
            basis_input("eps", ni[0] if ni else None, ni[1] if ni else None, bool(ni and ni[2])),
            basis_input(
                "fcf",
                ocf[0] - capex[0] if fcf_parts else None,
                ocf[1] if fcf_parts else None,
                bool(fcf_parts and ocf[2] and capex[2]),
            ),
            # No dividend tag at all → the company doesn't pay one: zero, not unknown.
            basis_input("dividend", abs(div[0]) if div else 0.0, div[1] if div else (ni[1] if ni else None), bool(div and div[2])),
        ]
        if ni and not ni[2]:
            notes.append("TTM — no quarterly XBRL in this company's filings (20-F/40-F filers report annually), so the latest fiscal year is used")

        tbv, tbv_as_of = self._tbv(normalize_balance_sheets(facts, basis), shares)
        latest = annual[0] if annual else None
        return _Fundamentals(
            route_symbol=route.symbol,
            us_listing=route.listing is None and route.symbol not in US_ORDINARY_SHARE_LISTINGS,
            foreign_filer=bool(latest and is_foreign_filer(latest)),
            name=facts.get("entityName", "") or symbol,
            source="SEC EDGAR",
            currency=basis.currency,
            bases=bases,
            tbv=tbv,
            tbv_as_of=tbv_as_of,
            shares=shares,
            notes=notes,
        )

    @staticmethod
    def _shares(facts: dict[str, Any], diluted_tags: list[str], annual: list[NormalizedPeriod], currency: str, as_of: str | None) -> float | None:
        """Diluted weighted-average shares, else net income ÷ diluted EPS of the latest year, else basic shares.

        A count dated more than ~15 months before the earnings it divides is stale (a discontinued tag) and skipped.
        """

        def fresh(found: tuple[float, str] | None) -> float | None:
            if found is None or (as_of and (_d(as_of) - _d(found[1])).days > 460):
                return None
            return found[0]

        if (shares := fresh(latest_shares(facts, diluted_tags))) is not None:
            return shares
        implied = annual_shares(annual[:1], facts, currency)
        if annual and (shares := implied.get(id(annual[0]))) and fresh((shares, annual[0].end)) is not None:
            return shares
        return fresh(latest_shares(facts, BASIC_SHARE_TAGS))

    @staticmethod
    def _tbv(balances: dict[str, dict[Metric, Any]], shares: float | None) -> tuple[float | None, str | None]:
        dated = sorted((d for d, v in balances.items() if Metric.STOCKHOLDERS_EQUITY in v), reverse=True)
        if not dated or not shares:
            return None, None
        as_of = dated[0]
        equity = balances[as_of][Metric.STOCKHOLDERS_EQUITY].value
        # Quarterly balance sheets often leave goodwill untagged: take the latest figure on or before the date.
        gi = next(
            (balances[d][Metric.GOODWILL_AND_INTANGIBLES].value for d in sorted(balances, reverse=True)
             if d <= as_of and Metric.GOODWILL_AND_INTANGIBLES in balances[d]),
            0.0,
        )  # fmt: skip
        return (equity - gi) / shares, as_of

    async def _from_fmp(self, symbol: str) -> _Fundamentals:
        statements = await self.financials.fmp.get_statements(symbol, PeriodType.ANNUAL)
        normalized = normalize_fmp_statements(statements, PeriodType.ANNUAL)
        annual = normalized.periods
        latest = annual[0] if annual else None
        shares = _v(latest, Metric.DILUTED_SHARES) if latest else None
        bases = []
        for key in BASES:
            h10, years, note = historical_growth(annual, key)
            value = _per_share(latest, key) if latest else None
            if key == "dividend" and value is None and latest is not None and shares:
                value = 0.0
            bases.append(BasisInput(key, BASES[key], value, f"FY ending {latest.end}" if latest else None, False, h10, years, note))
        tbv = None
        if latest and shares and (equity := _v(latest, Metric.STOCKHOLDERS_EQUITY)) is not None:
            tbv = (equity - (_v(latest, Metric.GOODWILL_AND_INTANGIBLES) or 0)) / shares
        try:
            name = (await self.financials.fmp.get_profile(symbol)).get("companyName") or symbol
        except Exception:  # noqa: BLE001 — the name is cosmetic
            name = symbol
        return _Fundamentals(
            symbol, False, False, name, "Financial Modeling Prep", normalized.currency or "USD", bases, tbv,
            latest.end if latest else None, shares,
            ["TTM — Financial Modeling Prep's free statements are annual, so the latest fiscal year is used"],
        )  # fmt: skip

    async def _with_price(self, f: _Fundamentals) -> DcfInputs:
        quote = await self.quotes.get_quote(f.route_symbol) if not f.route_symbol.isdigit() else None
        ctx = price_context(quote, f.currency, priced_us_listing=f.us_listing, foreign_filer=f.foreign_filer)
        currency, rate, comparable, note = f.currency, None, ctx.comparable, ctx.note
        adr = f.foreign_filer and f.us_listing
        if quote and not comparable and not adr and quote.currency != f.currency:
            fx = await self.quotes.get_snapshot(f"{f.currency}{quote.currency}=X")
            if fx and fx.price > 0:
                currency, rate, comparable = quote.currency, fx.price, True
                note = f"Filings are in {f.currency}; per-share figures converted to {quote.currency} at {fx.price:.4g} (Yahoo FX)"

        scale = rate or 1.0
        bases = [replace(b, value=b.value * scale if b.value is not None else None) for b in f.bases]
        factors = load_macro_factors()
        rf = factors.risk_free_rate
        return DcfInputs(
            symbol=f.route_symbol,
            name=f.name,
            source=f.source,
            currency=currency,
            reporting_currency=f.currency,
            fx_rate=rate,
            price=quote.price if quote else None,
            price_source=quote.source if quote else None,
            price_as_of=quote.as_of if quote else None,
            price_comparable=comparable,
            price_note=note,
            bases=bases,
            tbv=f.tbv * scale if f.tbv is not None else None,
            tbv_as_of=f.tbv_as_of,
            shares=f.shares,
            t10=round(rf.value * 100, 4),
            t10_as_of=rf.as_of,
            t10_source=rf.source,
            predictability=None,
            missing=[*MISSING_ALWAYS, *f.notes, *(b.h10_note and f"{b.label}: {b.h10_note}" for b in bases if b.h10_note)],
        )
