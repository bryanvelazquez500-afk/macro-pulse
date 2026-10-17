"""Legend investment checklist: a company's annual history scored against four investors' rules.

Each investor gets a few binary criteria computed from the normalized annual periods (so it works
the same for SEC and FMP data), and a verdict: "Worth Buying" only when every criterion passes,
otherwise "Pass". A criterion that can't be evaluated (missing data, not meaningful) counts as not
met — a checklist that can't confirm a rule doesn't recommend the stock.

These are mechanical screens inspired by each investor's published principles, not their actual
methods, and not investment advice.

  Buffett  ROIC > 15%                       NOPAT ÷ average (equity + long-term debt)
           Stable gross margins             max − min gross margin ≤ 5 pp over up to 5 years
  Lynch    PEG < 1.0                        (price ÷ diluted EPS) ÷ diluted-EPS CAGR in %
  Munger   Piotroski F-score ≥ 7            from the forensics module
           Low leverage                     long-term debt ÷ equity < 0.5
  Ackman   High operating leverage          operating-income CAGR ÷ revenue CAGR ≥ 1.25 (3 yrs)
           Recurring free cash flow         FCF positive in every one of up to 5 years

Expanded criteria:
  Buffett  Capital-light                    Σ capex ÷ Σ operating cash flow < 50% (up to 5 yrs)
           Declining share count            diluted shares lower than at the start of the window
           Expanding margins                operating margin higher than at the start of the window
  Lynch    Inventory discipline             inventory growth − revenue growth ≤ 5 pp (latest year)
           Net cash cushion                 cash + short-term investments − long-term debt > 0
  Munger   High gross margin                > 40% (latest year)
           Stable SG&A                      SG&A ÷ revenue range ≤ 3 pp, or lower than at the start
  Ackman   FCF yield on enterprise value     FCF ÷ (market cap + long-term debt − cash) ≥ 5%

"The start of the window" is the oldest of the last five fiscal years with data (at least three).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from enum import StrEnum

from app.services.forensics import compute_forensics
from app.services.gaap_mapping import Metric, NormalizedPeriod
from app.services.legend_context import LEGEND_CONTEXT, LegendContext
from app.services.quotes import Quote
from app.services.variance import find_prior_year_period

ROIC_MIN_PCT = 15.0
GROSS_MARGIN_MAX_RANGE_PP = 5.0
PEG_MAX = 1.0
PIOTROSKI_MIN = 7
LTD_TO_EQUITY_MAX = 0.5
OPERATING_LEVERAGE_MIN = 1.25
CAPEX_TO_OCF_MAX_PCT = 50.0
INVENTORY_GAP_MAX_PP = 5.0
GROSS_MARGIN_MIN_PCT = 40.0
SGA_MAX_RANGE_PP = 3.0
FCF_YIELD_MIN_PCT = 5.0
STATUTORY_TAX_RATE = 0.21  # used when the effective rate can't be computed

HISTORY_YEARS = 5  # periods examined for stability / consistency rules
MIN_HISTORY = 3
OPERATING_LEVERAGE_SPAN_YEARS = 3


class Verdict(StrEnum):
    WORTH_BUYING = "worth_buying"
    PASS = "pass"


@dataclass(frozen=True)
class Criterion:
    key: str
    label: str
    rule: str  # the threshold, in words: "> 15%"
    value: float | None  # the headline number the rule is applied to
    display: str | None  # human-readable result with its inputs
    passed: bool | None  # None: couldn't be evaluated
    note: str | None = None
    value_label: str | None = None  # the raw value, short and unit-formatted: "76.2%", "8/9", "1.06×"


@dataclass(frozen=True)
class InvestorChecklist:
    key: str
    name: str
    philosophy: str
    criteria: list[Criterion]
    verdict: Verdict
    summary: str
    context: LegendContext


@dataclass(frozen=True)
class PriceContext:
    """A quote plus whether it can be compared with the filings' per-share figures."""

    quote: Quote | None
    comparable: bool
    note: str | None = None


# ---------------------------------------------------------------- helpers


def _v(p: NormalizedPeriod, metric: Metric) -> float | None:
    item = p.values.get(metric)
    return item.value if item else None


def _opening(p: NormalizedPeriod, metric: Metric) -> float | None:
    item = p.opening_balances.get(metric)
    return item.value if item else None


def _years_between(newer: NormalizedPeriod, older: NormalizedPeriod) -> float:
    return (date.fromisoformat(newer.end) - date.fromisoformat(older.end)).days / 365.25


def _cagr(new: float, old: float, years: float) -> float | None:
    if years <= 0 or new <= 0 or old <= 0:
        return None
    return (new / old) ** (1 / years) - 1


def _fy(p: NormalizedPeriod) -> str:
    return f"FY{p.fiscal_year}" if p.fiscal_year else p.end[:4]


def _span(newer: NormalizedPeriod, older: NormalizedPeriod) -> str:
    return f"{_fy(older)}–{_fy(newer)}"


def _eps(p: NormalizedPeriod) -> float | None:
    net_income, shares = _v(p, Metric.NET_INCOME), _v(p, Metric.DILUTED_SHARES)
    return net_income / shares if net_income is not None and shares else None


def _money(value: float, currency: str) -> str:
    sign, v = ("−" if value < 0 else ""), abs(value)
    for scale, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if v >= scale:
            return f"{sign}{currency} {v / scale:.1f}{suffix}"
    return f"{sign}{currency} {v:,.0f}"


def _window(history: list[NormalizedPeriod], metric_fn) -> list[tuple[NormalizedPeriod, float]]:
    """(period, value) for each year in the window where `metric_fn` has data, newest first."""
    return [(p, v) for p in history if (v := metric_fn(p)) is not None]


def _ratio(p: NormalizedPeriod, numerator: Metric, denominator: Metric, scale: float = 100.0) -> float | None:
    n, d = _v(p, numerator), _v(p, denominator)
    return n / d * scale if n is not None and d else None


def _long_term_debt(p: NormalizedPeriod) -> tuple[float | None, str | None]:
    """Long-term debt, or 0 when untagged but liabilities are below equity (likely debt-free)."""
    debt = _v(p, Metric.LONG_TERM_DEBT)
    if debt is not None:
        return debt, None
    liabilities, equity = _v(p, Metric.TOTAL_LIABILITIES), _v(p, Metric.STOCKHOLDERS_EQUITY)
    if liabilities is not None and equity and equity > 0 and liabilities / equity < 1.0:
        return 0.0, "no long-term debt reported"
    return None, None


def _missing(key: str, label: str, rule: str, note: str) -> Criterion:
    return Criterion(key, label, rule, None, None, None, note)


# ---------------------------------------------------------------- Buffett


def effective_tax_rate(p: NormalizedPeriod) -> tuple[float, bool]:
    """(rate, is_effective). Falls back to the US statutory rate for losses or missing tags."""
    pretax, tax = _v(p, Metric.PRETAX_INCOME), _v(p, Metric.INCOME_TAX_EXPENSE)
    if pretax and pretax > 0 and tax is not None:
        return min(max(tax / pretax, 0.0), 0.5), True
    return STATUTORY_TAX_RATE, False


def roic(p: NormalizedPeriod) -> Criterion:
    key, label, rule = "roic", "Return on invested capital", f"> {ROIC_MIN_PCT:.0f}%"
    operating_income, equity = _v(p, Metric.OPERATING_INCOME), _v(p, Metric.STOCKHOLDERS_EQUITY)
    if operating_income is None or equity is None:
        return _missing(key, label, rule, "Operating income or equity not reported")

    closing = equity + (_v(p, Metric.LONG_TERM_DEBT) or 0)
    opening_equity = _opening(p, Metric.STOCKHOLDERS_EQUITY)
    invested = (closing + opening_equity + (_opening(p, Metric.LONG_TERM_DEBT) or 0)) / 2 if opening_equity is not None else closing
    if invested <= 0:
        return _missing(key, label, rule, "Invested capital is zero or negative (equity deficit) — ROIC not meaningful")

    rate, effective = effective_tax_rate(p)
    value = operating_income * (1 - rate) / invested * 100
    tax_note = f"{rate * 100:.0f}% effective tax" if effective else f"{rate * 100:.0f}% statutory tax assumed"
    return Criterion(
        key, label, rule, value,
        f"{value:.1f}% in {_fy(p)} (NOPAT at {tax_note} ÷ equity + long-term debt)",
        value > ROIC_MIN_PCT,
    )  # fmt: skip


def gross_margin_stability(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "gross_margin_stability", "Stable gross margins", f"range ≤ {GROSS_MARGIN_MAX_RANGE_PP:.0f} pp"
    margins = []
    for p in history:
        revenue, cogs = _v(p, Metric.REVENUE), _v(p, Metric.COST_OF_GOODS_SOLD)
        if revenue and revenue > 0 and cogs is not None:
            margins.append((p, (revenue - cogs) / revenue * 100))
    if len(margins) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of revenue and cost of goods sold (none for most banks)")
    values = [m for _, m in margins]
    spread = max(values) - min(values)
    return Criterion(
        key, label, rule, spread,
        f"{min(values):.1f}–{max(values):.1f}% ({spread:.1f} pp range, {_span(margins[0][0], margins[-1][0])})",
        spread <= GROSS_MARGIN_MAX_RANGE_PP,
    )  # fmt: skip


# ---------------------------------------------------------------- Lynch


def peg_ratio(history: list[NormalizedPeriod], price: PriceContext, currency: str) -> Criterion:
    key, label, rule = "peg", "PEG ratio", f"< {PEG_MAX:.1f}"
    if price.quote is None:
        return _missing(key, label, rule, price.note or "No share price available")
    if not price.comparable:
        return _missing(key, label, rule, price.note)
    if len(history) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of EPS history")

    newest = history[0]
    # Growth runs from the oldest year with EPS data, as long as it spans at least two years.
    with_eps = [p for p in history[1:] if _eps(p) is not None and _years_between(newest, p) >= MIN_HISTORY - 1.1]
    eps_now = _eps(newest)
    if eps_now is None or not with_eps:
        return _missing(key, label, rule, "Net income or diluted shares not reported for enough years")
    oldest = with_eps[-1]
    eps_then = _eps(oldest)
    if eps_now <= 0:
        return Criterion(key, label, rule, None, f"EPS {eps_now:.2f} {currency} in {_fy(newest)}", False, "Loss-making: no meaningful P/E")

    pe = price.quote.price / eps_now
    growth = _cagr(eps_now, eps_then, _years_between(newest, oldest))
    if growth is None or growth <= 0:
        return Criterion(
            key, label, rule, None, f"P/E {pe:.1f}; EPS {eps_then:.2f} → {eps_now:.2f} ({_span(newest, oldest)})", False,
            "EPS hasn't grown — PEG isn't meaningful, and Lynch wanted growth",
        )  # fmt: skip
    peg = pe / (growth * 100)
    return Criterion(
        key, label, rule, peg,
        f"{peg:.2f} (P/E {pe:.1f} ÷ {growth * 100:.1f}%/yr EPS growth, {_span(newest, oldest)})",
        peg < PEG_MAX,
    )  # fmt: skip


# ---------------------------------------------------------------- Munger


def piotroski(latest: NormalizedPeriod, periods: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "piotroski", "Piotroski F-score", f"≥ {PIOTROSKI_MIN}"
    f = compute_forensics(latest, find_prior_year_period(latest, periods)).piotroski
    if f is None or f.score is None:
        available = f.available if f else 0
        return _missing(key, label, rule, f"Only {available}/9 signals have data")
    return Criterion(key, label, rule, float(f.score), f"{f.score}/9 in {_fy(latest)}", f.score >= PIOTROSKI_MIN)


def leverage(p: NormalizedPeriod) -> Criterion:
    key, label, rule = "leverage", "Low leverage (long-term debt ÷ equity)", f"< {LTD_TO_EQUITY_MAX:.1f}"
    equity = _v(p, Metric.STOCKHOLDERS_EQUITY)
    if equity is None:
        return _missing(key, label, rule, "Equity not reported")
    if equity <= 0:
        return Criterion(key, label, rule, None, f"Equity {equity:,.0f} in {_fy(p)}", False, "Negative equity: liabilities exceed assets")
    debt = _v(p, Metric.LONG_TERM_DEBT)
    if debt is None:
        # No debt tag means either no debt or debt reported some other way (banks fund with deposits).
        # Only call it debt-free when total liabilities are small relative to equity too.
        liabilities = _v(p, Metric.TOTAL_LIABILITIES)
        if liabilities is not None and liabilities / equity < 1.0:
            return Criterion(
                key, label, rule, 0.0, f"No long-term debt reported; liabilities {liabilities / equity:.2f}× equity", True
            )
        return _missing(key, label, rule, "Long-term debt not reported and liabilities exceed equity — can't confirm low leverage")
    ratio = debt / equity
    return Criterion(key, label, rule, ratio, f"{ratio:.2f} in {_fy(p)}", ratio < LTD_TO_EQUITY_MAX)


# ---------------------------------------------------------------- Ackman


def operating_leverage(periods: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "operating_leverage", "High operating leverage", f"≥ {OPERATING_LEVERAGE_MIN:.2f}×"
    if len(periods) <= OPERATING_LEVERAGE_SPAN_YEARS:
        return _missing(key, label, rule, f"Needs {OPERATING_LEVERAGE_SPAN_YEARS + 1} years of history")
    newest, oldest = periods[0], periods[OPERATING_LEVERAGE_SPAN_YEARS]
    years = _years_between(newest, oldest)
    rev_new, rev_old = _v(newest, Metric.REVENUE), _v(oldest, Metric.REVENUE)
    op_new, op_old = _v(newest, Metric.OPERATING_INCOME), _v(oldest, Metric.OPERATING_INCOME)
    if None in (rev_new, rev_old, op_new, op_old):
        return _missing(key, label, rule, "Revenue or operating income not reported")
    rev_growth = _cagr(rev_new, rev_old, years)
    if rev_growth is None or rev_growth <= 0:
        return Criterion(
            key, label, rule, None, f"Revenue {_span(newest, oldest)}: not growing", False,
            "Operating leverage only helps a growing business — here it works in reverse",
        )  # fmt: skip
    op_growth = _cagr(op_new, op_old, years)
    if op_growth is None:
        return Criterion(key, label, rule, None, None, False, "Operating loss at the start or end of the span")
    dol = op_growth / rev_growth
    return Criterion(
        key, label, rule, dol,
        f"{dol:.2f}× (operating income {op_growth * 100:+.1f}%/yr vs revenue {rev_growth * 100:+.1f}%/yr, {_span(newest, oldest)})",
        dol >= OPERATING_LEVERAGE_MIN,
    )  # fmt: skip


def recurring_free_cash_flow(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "recurring_fcf", "Recurring free cash flow", "> 0 every yr"
    years = [(p, fcf) for p in history if (fcf := _v(p, Metric.FREE_CASH_FLOW)) is not None]
    if len(years) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of operating cash flow")
    positive = sum(fcf > 0 for _, fcf in years)
    return Criterion(
        key, label, rule, float(positive),
        f"{positive}/{len(years)} years positive ({_span(years[0][0], years[-1][0])})",
        positive == len(years), value_label=f"{positive}/{len(years)} yrs",
    )  # fmt: skip


# ---------------------------------------------------------------- expanded criteria


def capex_intensity(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "capex_to_ocf", "Capital-light (capex ÷ operating cash flow)", f"< {CAPEX_TO_OCF_MAX_PCT:.0f}%"
    years = [(p, c, o) for p in history if (c := _v(p, Metric.CAPITAL_EXPENDITURES)) is not None and (o := _v(p, Metric.OPERATING_CASH_FLOW)) is not None]
    if len(years) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of capex and operating cash flow")
    capex, ocf = sum(c for _, c, _ in years), sum(o for _, _, o in years)
    span = _span(years[0][0], years[-1][0])
    if ocf <= 0:
        return Criterion(key, label, rule, None, f"Cumulative operating cash flow negative ({span})", False)
    value = capex / ocf * 100
    # Summed across years: a single heavy-investment year shouldn't decide it.
    return Criterion(key, label, rule, value, f"{value:.1f}% of operating cash flow, {span} combined", value < CAPEX_TO_OCF_MAX_PCT)


def share_count_trend(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "share_count", "Declining share count", "fewer diluted shares"
    years = _window(history, lambda p: _v(p, Metric.DILUTED_SHARES))
    if len(years) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of diluted share counts")
    (newest, now), (oldest, then) = years[0], years[-1]
    change = (now / then - 1) * 100
    per_year = ((now / then) ** (1 / _years_between(newest, oldest)) - 1) * 100
    return Criterion(
        key, label, rule, change, f"{change:+.1f}% ({per_year:+.1f}%/yr), {_span(newest, oldest)}", now < then,
        None if now < then else "Share count grew: buybacks aren't offsetting issuance",
    )  # fmt: skip


def margin_expansion(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "margin_expansion", "Expanding operating margins", "higher than 5 yrs ago"
    years = _window(history, lambda p: _ratio(p, Metric.OPERATING_INCOME, Metric.REVENUE) if (_v(p, Metric.REVENUE) or 0) > 0 else None)
    if len(years) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of revenue and operating income")
    (newest, now), (oldest, then) = years[0], years[-1]
    return Criterion(
        key, label, rule, now - then,
        f"{then:.1f}% → {now:.1f}% ({now - then:+.1f} pp, {_span(newest, oldest)})", now > then,
    )  # fmt: skip


def inventory_vs_sales(latest: NormalizedPeriod, prior: NormalizedPeriod | None) -> Criterion:
    key, label, rule = "inventory_vs_sales", "Inventory not outrunning sales", f"gap ≤ {INVENTORY_GAP_MAX_PP:.0f} pp"
    if prior is None:
        return _missing(key, label, rule, "No prior fiscal year to compare")
    inv_now, inv_then = _v(latest, Metric.INVENTORY), _v(prior, Metric.INVENTORY)
    rev_now, rev_then = _v(latest, Metric.REVENUE), _v(prior, Metric.REVENUE)
    if inv_now is None and inv_then is None:
        # Lynch's red flag is stock piling up unsold; a business that carries none can't trip it.
        return Criterion(key, label, rule, None, "No inventory on the balance sheet", True, "Not applicable — no inventory reported")
    if None in (inv_now, inv_then, rev_now, rev_then) or not inv_then or not rev_then:
        return _missing(key, label, rule, "Inventory or revenue missing for one of the two years")
    inv_growth, rev_growth = (inv_now / inv_then - 1) * 100, (rev_now / rev_then - 1) * 100
    gap = inv_growth - rev_growth
    return Criterion(
        key, label, rule, gap,
        f"inventory {inv_growth:+.1f}% vs revenue {rev_growth:+.1f}% ({gap:+.1f} pp), {_fy(latest)}", gap <= INVENTORY_GAP_MAX_PP,
        "Inventories piling up faster than sales — Lynch's classic warning sign" if gap > INVENTORY_GAP_MAX_PP else None,
    )  # fmt: skip


def net_cash(p: NormalizedPeriod, currency: str) -> Criterion:
    key, label, rule = "net_cash", "Net cash cushion", "cash > long-term debt"
    cash = _v(p, Metric.CASH_AND_EQUIVALENTS)
    if cash is None:
        return _missing(key, label, rule, "Cash not reported")
    debt, note = _long_term_debt(p)
    if debt is None:
        return _missing(key, label, rule, "Long-term debt not reported and liabilities exceed equity")
    liquid = cash + (_v(p, Metric.SHORT_TERM_INVESTMENTS) or 0)
    value = liquid - debt
    return Criterion(
        key, label, rule, value,
        f"{_money(value, currency)} (cash + investments {_money(liquid, currency)} − debt {_money(debt, currency)}), {_fy(p)}",
        value > 0, note, value_label=_money(value, currency),
    )  # fmt: skip


def gross_margin_level(p: NormalizedPeriod) -> Criterion:
    key, label, rule = "gross_margin", "High gross margin", f"> {GROSS_MARGIN_MIN_PCT:.0f}%"
    revenue = _v(p, Metric.REVENUE)
    cogs = _v(p, Metric.COST_OF_GOODS_SOLD)
    if not revenue or revenue <= 0 or cogs is None:
        return _missing(key, label, rule, "Revenue or cost of goods sold not reported")
    margin = (revenue - cogs) / revenue * 100
    return Criterion(key, label, rule, margin, f"{margin:.1f}% in {_fy(p)}", margin > GROSS_MARGIN_MIN_PCT)


def sga_stability(history: list[NormalizedPeriod]) -> Criterion:
    key, label, rule = "sga_stability", "Stable SG&A (% of revenue)", f"range ≤ {SGA_MAX_RANGE_PP:.0f} pp or falling"
    years = _window(history, lambda p: _ratio(p, Metric.SGA_EXPENSE, Metric.REVENUE) if (_v(p, Metric.REVENUE) or 0) > 0 else None)
    if len(years) < MIN_HISTORY:
        return _missing(key, label, rule, f"Needs ≥{MIN_HISTORY} years of SG&A (not reported separately by many banks)")
    values = [v for _, v in years]
    (newest, now), (oldest, then) = years[0], years[-1]
    spread = max(values) - min(values)
    stable, falling = spread <= SGA_MAX_RANGE_PP, now < then
    return Criterion(
        key, label, rule, spread,
        f"{then:.1f}% → {now:.1f}% of revenue ({spread:.1f} pp range, {_span(newest, oldest)})", stable or falling,
        "Overhead rising faster than sales" if not (stable or falling) else None,
    )  # fmt: skip


def fcf_yield(p: NormalizedPeriod, price: PriceContext, currency: str) -> Criterion:
    key, label, rule = "fcf_yield", "Free-cash-flow yield on enterprise value", f"≥ {FCF_YIELD_MIN_PCT:.0f}%"
    if price.quote is None or not price.comparable:
        return _missing(key, label, rule, price.note or "No share price available")
    fcf, shares, cash = _v(p, Metric.FREE_CASH_FLOW), _v(p, Metric.DILUTED_SHARES), _v(p, Metric.CASH_AND_EQUIVALENTS)
    debt, _ = _long_term_debt(p)
    if fcf is None or not shares or cash is None or debt is None:
        return _missing(key, label, rule, "Free cash flow, share count, cash or debt not reported")
    market_cap = price.quote.price * shares
    ev = market_cap + debt - cash - (_v(p, Metric.SHORT_TERM_INVESTMENTS) or 0)
    if ev <= 0:
        return Criterion(key, label, rule, None, f"EV {_money(ev, currency)}", None, "Enterprise value ≤ 0 (cash exceeds market cap + debt) — yield not meaningful")
    value = fcf / ev * 100
    return Criterion(
        key, label, rule, value,
        f"{value:.1f}% ({_fy(p)} FCF {_money(fcf, currency)} ÷ EV {_money(ev, currency)})", value >= FCF_YIELD_MIN_PCT,
        "EV uses the latest diluted share count and long-term debt only",
    )  # fmt: skip


# ---------------------------------------------------------------- verdicts


# How each criterion's raw value reads on its own (criteria with units that vary set value_label themselves).
_VALUE_FORMATS: dict[str, str] = {
    "roic": "{:.1f}%",
    "gross_margin_stability": "{:.1f} pp",
    "capex_to_ocf": "{:.1f}%",
    "share_count": "{:+.1f}%",
    "margin_expansion": "{:+.1f} pp",
    "peg": "{:.2f}",
    "inventory_vs_sales": "{:+.1f} pp",
    "piotroski": "{:.0f}/9",
    "leverage": "{:.2f}×",
    "gross_margin": "{:.1f}%",
    "sga_stability": "{:.1f} pp",
    "operating_leverage": "{:.2f}×",
    "fcf_yield": "{:.1f}%",
}


def _with_value_label(c: Criterion) -> Criterion:
    if c.value_label is not None or c.value is None or c.key not in _VALUE_FORMATS:
        return c
    return replace(c, value_label=_VALUE_FORMATS[c.key].format(c.value).replace("-", "−"))


def _checklist(key: str, name: str, philosophy: str, criteria: list[Criterion]) -> InvestorChecklist:
    criteria = [_with_value_label(c) for c in criteria]
    failed = [c.label for c in criteria if c.passed is False]
    unknown = [c.label for c in criteria if c.passed is None]
    if not failed and not unknown:
        verdict, summary = Verdict.WORTH_BUYING, f"Meets all {len(criteria)} criteria"
    elif failed:
        verdict, summary = Verdict.PASS, "Fails: " + ", ".join(failed) + (f"; no data for {', '.join(unknown)}" if unknown else "")
    else:
        verdict, summary = Verdict.PASS, "Can't confirm: " + ", ".join(unknown)
    return InvestorChecklist(key, name, philosophy, criteria, verdict, summary, LEGEND_CONTEXT[key])


def evaluate(annual_periods: list[NormalizedPeriod], price: PriceContext, currency: str) -> list[InvestorChecklist]:
    """`annual_periods` newest first. Returns one checklist per investor (empty without data)."""
    if not annual_periods:
        return []
    latest = annual_periods[0]
    prior = find_prior_year_period(latest, annual_periods)
    history = annual_periods[:HISTORY_YEARS]
    return [
        _checklist(
            "buffett", "Warren Buffett", "Durable moats: high returns on capital and pricing power",
            [roic(latest), gross_margin_stability(history), capex_intensity(history), share_count_trend(history), margin_expansion(history)],
        ),
        _checklist(
            "lynch", "Peter Lynch", "Growth at a reasonable price",
            [peg_ratio(history, price, currency), inventory_vs_sales(latest, prior), net_cash(latest, currency)],
        ),
        _checklist(
            "munger", "Charlie Munger", "Quality businesses that can't be wiped out",
            [piotroski(latest, annual_periods), leverage(latest), gross_margin_level(latest), sga_stability(history)],
        ),
        _checklist(
            "ackman", "Bill Ackman", "Simple, predictable, free-cash-flow-generative compounders",
            [operating_leverage(annual_periods), recurring_free_cash_flow(history), fcf_yield(latest, price, currency)],
        ),
    ]  # fmt: skip
