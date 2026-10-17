"""Forensic accounting scores, computed from a fiscal year and the same fiscal year one year earlier.

- Piotroski F-score: nine binary financial-strength signals (higher is stronger, 0-9).
- Altman Z''-score: bankruptcy-risk model. Uses the book-equity variant (Altman 1995) because
  we have no market prices: Z'' = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4.
- Sloan accrual ratio: (net income − operating cash flow) ÷ average total assets. Large positive
  accruals mean earnings are running ahead of cash and historically predict weaker future earnings.

All three need full-year income and cash-flow figures, so they're computed for annual periods only.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.services.gaap_mapping import Metric, NormalizedPeriod, PeriodType

ALTMAN_SAFE_ABOVE = 2.6
ALTMAN_DISTRESS_BELOW = 1.1
SLOAN_WARNING_ABOVE_PCT = 10.0


@dataclass(frozen=True)
class Signal:
    key: str
    label: str
    passed: bool | None  # None when inputs are missing


@dataclass(frozen=True)
class Piotroski:
    score: int | None  # passed signals; None when fewer than 7 of 9 could be evaluated
    available: int  # signals with enough data
    signals: list[Signal] = field(default_factory=list)


@dataclass(frozen=True)
class Scored:
    value: float | None
    zone: str | None
    note: str | None = None


@dataclass(frozen=True)
class Forensics:
    piotroski: Piotroski | None
    altman_z: Scored | None
    sloan_accruals_pct: Scored | None
    note: str | None = None


# A score built from too few signals isn't comparable across companies.
_PIOTROSKI_MIN_SIGNALS = 7


def _v(p: NormalizedPeriod | None, metric: Metric) -> float | None:
    if p is None:
        return None
    item = p.values.get(metric)
    return item.value if item else None


def _opening_assets(p: NormalizedPeriod) -> float | None:
    item = p.opening_balances.get(Metric.TOTAL_ASSETS)
    return item.value if item else None


def _avg_assets(p: NormalizedPeriod) -> float | None:
    closing, opening = _v(p, Metric.TOTAL_ASSETS), _opening_assets(p)
    if closing is None:
        return None
    return (closing + opening) / 2 if opening is not None else closing


def _ratio(n: float | None, d: float | None) -> float | None:
    return n / d if n is not None and d not in (None, 0) else None


def _gt(a: float | None, b: float | None) -> bool | None:
    return None if a is None or b is None else a > b


def _roa(p: NormalizedPeriod | None) -> float | None:
    return None if p is None else _ratio(_v(p, Metric.NET_INCOME), _opening_assets(p) or _v(p, Metric.TOTAL_ASSETS))


def _leverage(p: NormalizedPeriod | None) -> float | None:
    if p is None:
        return None
    debt = _v(p, Metric.LONG_TERM_DEBT)
    return _ratio(debt, _avg_assets(p))


def _current_ratio(p: NormalizedPeriod | None) -> float | None:
    return _ratio(_v(p, Metric.CURRENT_ASSETS), _v(p, Metric.CURRENT_LIABILITIES))


def _gross_margin(p: NormalizedPeriod | None) -> float | None:
    revenue, cogs = _v(p, Metric.REVENUE), _v(p, Metric.COST_OF_GOODS_SOLD)
    return _ratio(revenue - cogs, revenue) if revenue is not None and cogs is not None else None


def _asset_turnover(p: NormalizedPeriod | None) -> float | None:
    return None if p is None else _ratio(_v(p, Metric.REVENUE), _opening_assets(p) or _v(p, Metric.TOTAL_ASSETS))


def piotroski(p: NormalizedPeriod, prior: NormalizedPeriod | None) -> Piotroski:
    ni, cfo = _v(p, Metric.NET_INCOME), _v(p, Metric.OPERATING_CASH_FLOW)
    roa, prior_roa = _roa(p), _roa(prior)
    shares, prior_shares = _v(p, Metric.DILUTED_SHARES), _v(prior, Metric.DILUTED_SHARES)
    leverage, prior_leverage = _leverage(p), _leverage(prior)

    signals = [
        Signal("roa_positive", "Positive return on assets", None if roa is None else roa > 0),
        Signal("cfo_positive", "Positive operating cash flow", None if cfo is None else cfo > 0),
        Signal("roa_improving", "Return on assets improved", _gt(roa, prior_roa)),
        Signal("cash_over_earnings", "Operating cash flow exceeds net income", _gt(cfo, ni)),
        Signal("leverage_falling", "Long-term debt / assets fell", _gt(prior_leverage, leverage)),
        Signal("liquidity_improving", "Current ratio improved", _gt(_current_ratio(p), _current_ratio(prior))),
        # Diluted share count stands in for "no new equity issued"; ≤ 0.5% growth counts as flat.
        Signal(
            "no_dilution",
            "No share dilution",
            None if shares is None or prior_shares is None else shares <= prior_shares * 1.005,
        ),
        Signal("margin_improving", "Gross margin improved", _gt(_gross_margin(p), _gross_margin(prior))),
        Signal("turnover_improving", "Asset turnover improved", _gt(_asset_turnover(p), _asset_turnover(prior))),
    ]
    available = sum(s.passed is not None for s in signals)
    score = sum(bool(s.passed) for s in signals) if available >= _PIOTROSKI_MIN_SIGNALS else None
    return Piotroski(score=score, available=available, signals=signals)


def altman_z(p: NormalizedPeriod) -> Scored:
    total_assets = _v(p, Metric.TOTAL_ASSETS)
    current_assets, current_liabilities = _v(p, Metric.CURRENT_ASSETS), _v(p, Metric.CURRENT_LIABILITIES)
    retained, ebit = _v(p, Metric.RETAINED_EARNINGS), _v(p, Metric.OPERATING_INCOME)
    equity, liabilities = _v(p, Metric.STOCKHOLDERS_EQUITY), _v(p, Metric.TOTAL_LIABILITIES)

    inputs = (total_assets, current_assets, current_liabilities, retained, ebit, equity, liabilities)
    if any(v is None for v in inputs) or not total_assets or not liabilities:
        missing_ca = current_assets is None or current_liabilities is None
        return Scored(None, None, "Needs a classified balance sheet" if missing_ca else "Inputs not reported")

    z = (
        6.56 * (current_assets - current_liabilities) / total_assets
        + 3.26 * retained / total_assets
        + 6.72 * ebit / total_assets
        + 1.05 * equity / liabilities
    )
    zone = "safe" if z > ALTMAN_SAFE_ABOVE else "distress" if z < ALTMAN_DISTRESS_BELOW else "grey"
    return Scored(z, zone)


def sloan_accruals(p: NormalizedPeriod) -> Scored:
    ni, cfo, assets = _v(p, Metric.NET_INCOME), _v(p, Metric.OPERATING_CASH_FLOW), _avg_assets(p)
    if ni is None or cfo is None or not assets:
        return Scored(None, None, "Inputs not reported")
    pct = (ni - cfo) / assets * 100
    zone = "high" if pct > SLOAN_WARNING_ABOVE_PCT else "low" if pct < -SLOAN_WARNING_ABOVE_PCT else "normal"
    return Scored(pct, zone)


def compute_forensics(p: NormalizedPeriod, prior: NormalizedPeriod | None) -> Forensics:
    if p.period_type is not PeriodType.ANNUAL:
        return Forensics(None, None, None, note="Forensic scores use full fiscal years; switch to annual.")
    return Forensics(piotroski(p, prior), altman_z(p), sloan_accruals(p))
