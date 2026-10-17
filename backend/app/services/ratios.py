"""Audit ratios computed from a normalized period's income statement and balance sheets."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.services.gaap_mapping import Metric, NormalizedPeriod, PeriodType


class RatioKey(StrEnum):
    CURRENT_RATIO = "current_ratio"
    QUICK_RATIO = "quick_ratio"
    DEBT_TO_EQUITY = "debt_to_equity"
    GROSS_MARGIN_PCT = "gross_margin_pct"
    OPERATING_MARGIN_PCT = "operating_margin_pct"
    NET_MARGIN_PCT = "net_margin_pct"
    ASSET_TURNOVER = "asset_turnover"


@dataclass(frozen=True)
class RatioResult:
    value: float | None
    formula: str
    # Explains a null value or a fallback calculation method.
    note: str | None = None


def _v(period: NormalizedPeriod, metric: Metric) -> float | None:
    item = period.values.get(metric)
    return item.value if item else None


def _divide(numerator: float | None, denominator: float | None, formula: str, scale: float = 1.0) -> RatioResult | None:
    if numerator is None or denominator is None:
        return None
    if denominator == 0:
        return RatioResult(None, formula, "Denominator is zero")
    return RatioResult(numerator / denominator * scale, formula)


def current_ratio(p: NormalizedPeriod) -> RatioResult | None:
    return _divide(_v(p, Metric.CURRENT_ASSETS), _v(p, Metric.CURRENT_LIABILITIES), "Current Assets ÷ Current Liabilities")


def quick_ratio(p: NormalizedPeriod) -> RatioResult | None:
    current_liabilities = _v(p, Metric.CURRENT_LIABILITIES)
    cash = _v(p, Metric.CASH_AND_EQUIVALENTS)
    if cash is not None:
        # Short-term investments / receivables that aren't reported are treated as zero.
        quick_assets = cash + (_v(p, Metric.SHORT_TERM_INVESTMENTS) or 0) + (_v(p, Metric.ACCOUNTS_RECEIVABLE) or 0)
        return _divide(quick_assets, current_liabilities, "(Cash + Short-Term Investments + Receivables) ÷ Current Liabilities")

    current_assets = _v(p, Metric.CURRENT_ASSETS)
    if current_assets is None:
        return None
    result = _divide(
        current_assets - (_v(p, Metric.INVENTORY) or 0),
        current_liabilities,
        "(Current Assets − Inventory) ÷ Current Liabilities",
    )
    if result and result.value is not None:
        return RatioResult(result.value, result.formula, "Cash not reported; used Current Assets − Inventory")
    return result


def debt_to_equity(p: NormalizedPeriod) -> RatioResult | None:
    formula = "Total Liabilities ÷ Stockholders' Equity"
    equity = _v(p, Metric.STOCKHOLDERS_EQUITY)
    if equity is not None and equity <= 0 and _v(p, Metric.TOTAL_LIABILITIES) is not None:
        return RatioResult(None, formula, "Not meaningful: stockholders' equity is zero or negative")
    return _divide(_v(p, Metric.TOTAL_LIABILITIES), equity, formula)


def margin(p: NormalizedPeriod, numerator: float | None, label: str) -> RatioResult | None:
    return _divide(numerator, _v(p, Metric.REVENUE), f"{label} ÷ Revenue × 100", scale=100)


def asset_turnover(p: NormalizedPeriod) -> RatioResult | None:
    revenue = _v(p, Metric.REVENUE)
    closing = _v(p, Metric.TOTAL_ASSETS)
    opening = p.opening_balances.get(Metric.TOTAL_ASSETS)
    suffix = " (quarterly, not annualized)" if p.period_type is PeriodType.QUARTERLY else ""
    if opening is not None and closing is not None:
        return _divide(revenue, (opening.value + closing) / 2, f"Revenue ÷ Average Total Assets{suffix}")

    result = _divide(revenue, closing, f"Revenue ÷ Ending Total Assets{suffix}")
    if result and result.value is not None:
        return RatioResult(result.value, result.formula, "Opening balance sheet unavailable; used ending assets")
    return result


def compute_ratios(p: NormalizedPeriod) -> dict[RatioKey, RatioResult | None]:
    revenue, cogs = _v(p, Metric.REVENUE), _v(p, Metric.COST_OF_GOODS_SOLD)
    gross_profit = revenue - cogs if revenue is not None and cogs is not None else None
    return {
        RatioKey.CURRENT_RATIO: current_ratio(p),
        RatioKey.QUICK_RATIO: quick_ratio(p),
        RatioKey.DEBT_TO_EQUITY: debt_to_equity(p),
        RatioKey.GROSS_MARGIN_PCT: margin(p, gross_profit, "(Revenue − COGS)"),
        RatioKey.OPERATING_MARGIN_PCT: margin(p, _v(p, Metric.OPERATING_INCOME), "Operating Income"),
        RatioKey.NET_MARGIN_PCT: margin(p, _v(p, Metric.NET_INCOME), "Net Income"),
        RatioKey.ASSET_TURNOVER: asset_turnover(p),
    }
