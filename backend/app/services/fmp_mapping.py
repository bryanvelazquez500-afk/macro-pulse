"""Maps Financial Modeling Prep's standardized statements onto our internal metrics.

FMP already normalizes every company (US or international, IFRS or local GAAP) into one schema of
camelCase fields, so the mapping is field → Metric rather than tag → Metric. Field names follow the
`/stable` API (verified against FinanceToolkit's maintained FMP normalization tables).

Differences from SEC data that the mapping handles:
  - Rows carry only the period's end `date`; start dates are inferred from the previous period.
  - Unreported fields come back as 0, not null. A zero is treated as "not reported" except where
    zero is a genuine value (no inventory, no short-term investments, no debt, no capex).
  - Capital expenditure is signed as a cash outflow (negative); our convention is a positive amount.
  - A company can change reporting currency; only rows in the latest currency are kept, so
    variances never compare euros with dollars.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.services.fmp_client import FmpStatements
from app.services.gaap_mapping import (
    Metric,
    NormalizedPeriod,
    NormalizedValue,
    PeriodType,
    balance_sheet_near,
    derive_free_cash_flow,
)

INCOME, BALANCE, CASH_FLOW = "income-statement", "balance-sheet-statement", "cash-flow-statement"

# Metric → (statement, field) candidates in priority order.
FMP_FIELD_MAP: dict[Metric, list[tuple[str, str]]] = {
    Metric.REVENUE: [(INCOME, "revenue")],
    Metric.COST_OF_GOODS_SOLD: [(INCOME, "costOfRevenue")],
    Metric.OPERATING_INCOME: [(INCOME, "operatingIncome")],
    # bottomLineNetIncome is after minority-interest deductions, i.e. attributable to the parent.
    Metric.NET_INCOME: [(INCOME, "bottomLineNetIncome"), (INCOME, "netIncome")],
    Metric.PRETAX_INCOME: [(INCOME, "incomeBeforeTax")],
    Metric.INCOME_TAX_EXPENSE: [(INCOME, "incomeTaxExpense")],
    Metric.SGA_EXPENSE: [(INCOME, "sellingGeneralAndAdministrativeExpenses")],
    Metric.DIVIDENDS_PAID: [(CASH_FLOW, "commonDividendsPaid"), (CASH_FLOW, "netDividendsPaid")],
    Metric.DILUTED_SHARES: [(INCOME, "weightedAverageShsOutDil")],
    Metric.OPERATING_CASH_FLOW: [(CASH_FLOW, "operatingCashFlow"), (CASH_FLOW, "netCashProvidedByOperatingActivities")],
    Metric.CAPITAL_EXPENDITURES: [(CASH_FLOW, "capitalExpenditure"), (CASH_FLOW, "investmentsInPropertyPlantAndEquipment")],
    Metric.CASH_AND_EQUIVALENTS: [(BALANCE, "cashAndCashEquivalents")],
    Metric.SHORT_TERM_INVESTMENTS: [(BALANCE, "shortTermInvestments")],
    Metric.ACCOUNTS_RECEIVABLE: [(BALANCE, "accountsReceivables"), (BALANCE, "netReceivables")],
    Metric.INVENTORY: [(BALANCE, "inventory")],
    Metric.CURRENT_ASSETS: [(BALANCE, "totalCurrentAssets")],
    Metric.TOTAL_ASSETS: [(BALANCE, "totalAssets")],
    Metric.CURRENT_LIABILITIES: [(BALANCE, "totalCurrentLiabilities")],
    Metric.TOTAL_LIABILITIES: [(BALANCE, "totalLiabilities")],
    Metric.STOCKHOLDERS_EQUITY: [(BALANCE, "totalStockholdersEquity"), (BALANCE, "totalEquity")],
    Metric.RETAINED_EARNINGS: [(BALANCE, "retainedEarnings")],
    Metric.LONG_TERM_DEBT: [(BALANCE, "longTermDebt")],
    Metric.GOODWILL_AND_INTANGIBLES: [(BALANCE, "goodwillAndIntangibleAssets")],
}

_BALANCE_METRICS = {m for m, fields in FMP_FIELD_MAP.items() if fields[0][0] == BALANCE}
# Zero is a real answer for these; for everything else FMP's 0 means "not reported".
_ZERO_IS_VALID = {
    Metric.SHORT_TERM_INVESTMENTS, Metric.INVENTORY, Metric.LONG_TERM_DEBT, Metric.CAPITAL_EXPENDITURES, Metric.DIVIDENDS_PAID,
    Metric.GOODWILL_AND_INTANGIBLES,
}  # fmt: skip
_OUTFLOWS = {Metric.CAPITAL_EXPENDITURES, Metric.DIVIDENDS_PAID}

DERIVED_FMP_LIABILITIES_TAG = "balance-sheet-statement.totalLiabilitiesAndTotalEquity − totalEquity (derived)"

_PERIOD_DAYS = {PeriodType.ANNUAL: (350, 380, 365), PeriodType.QUARTERLY: (80, 100, 91)}


def source_tag(statement: str, field: str) -> str:
    return f"{statement}.{field}"


def fmp_tag_map() -> dict[Metric, list[str]]:
    tags = {metric: [source_tag(*f) for f in fields] for metric, fields in FMP_FIELD_MAP.items()}
    tags[Metric.FREE_CASH_FLOW] = []
    return tags


@dataclass(frozen=True)
class FmpNormalized:
    periods: list[NormalizedPeriod]  # newest first
    currency: str | None


def _number(row: dict[str, Any], field: str) -> float | None:
    value = row.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _filed(row: dict[str, Any]) -> str:
    return str(row.get("filingDate") or row.get("acceptedDate") or "")[:10]


def _value(metric: Metric, rows: dict[str, dict[str, Any] | None], form: str) -> NormalizedValue | None:
    for statement, field in FMP_FIELD_MAP[metric]:
        row = rows.get(statement)
        value = _number(row, field) if row else None
        if value is None or (value == 0 and metric not in _ZERO_IS_VALID):
            continue
        if metric in _OUTFLOWS:
            value = abs(value)
        return NormalizedValue(value=value, source_tag=source_tag(statement, field), accession_number=None, form=form, filed=_filed(row))
    return None


def _derive_total_liabilities(row: dict[str, Any], form: str) -> NormalizedValue | None:
    total, equity = _number(row, "totalLiabilitiesAndTotalEquity"), _number(row, "totalEquity")
    if not total or equity is None:
        return None
    return NormalizedValue(total - equity, DERIVED_FMP_LIABILITIES_TAG, None, form, _filed(row))


def _fiscal_year(row: dict[str, Any]) -> int | None:
    for field in ("fiscalYear", "calendarYear"):  # `calendarYear` on older responses
        try:
            return int(row[field])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def _same_currency(rows: list[dict[str, Any]], currency: str | None) -> list[dict[str, Any]]:
    return [r for r in rows if currency is None or r.get("reportedCurrency") in (None, currency)]


def _by_date(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(r["date"]): r for r in rows if r.get("date")}


def normalize_fmp_statements(statements: FmpStatements, period_type: PeriodType) -> FmpNormalized:
    income_rows = sorted((r for r in statements.income if r.get("date")), key=lambda r: r["date"], reverse=True)
    currency = next((r["reportedCurrency"] for r in income_rows if r.get("reportedCurrency")), None)
    income_rows = _same_currency(income_rows, currency)
    balances_by_date = _by_date(_same_currency(statements.balance, currency))
    cash_by_date = _by_date(_same_currency(statements.cash_flow, currency))

    # Balance sheets keyed by date, for closing and opening balances (as in the SEC pipeline).
    balances: dict[str, dict[Metric, NormalizedValue]] = {}
    for end, row in balances_by_date.items():
        form = f"FMP {row.get('period') or ''}".strip()
        values = {m: v for m in _BALANCE_METRICS if (v := _value(m, {BALANCE: row}, form))}
        if Metric.TOTAL_LIABILITIES not in values and (derived := _derive_total_liabilities(row, form)):
            values[Metric.TOTAL_LIABILITIES] = derived
        balances[end] = values

    min_days, max_days, default_days = _PERIOD_DAYS[period_type]
    periods: list[NormalizedPeriod] = []
    for i, row in enumerate(income_rows):
        end = date.fromisoformat(str(row["date"])[:10])
        older = income_rows[i + 1] if i + 1 < len(income_rows) else None
        older_end = date.fromisoformat(str(older["date"])[:10]) if older else None
        # The period starts the day after the previous one ended, when that one is adjacent.
        if older_end and min_days <= (end - older_end).days <= max_days:
            start = older_end + timedelta(days=1)
        else:
            start = end - timedelta(days=default_days - 1)

        form = f"FMP {row.get('period') or ''}".strip()
        rows = {INCOME: row, CASH_FLOW: cash_by_date.get(row["date"])}
        values = {m: v for m in FMP_FIELD_MAP if m not in _BALANCE_METRICS and (v := _value(m, rows, form))}
        period = NormalizedPeriod(
            period_type=period_type,
            start=start.isoformat(),
            end=end.isoformat(),
            fiscal_year=_fiscal_year(row),
            fiscal_period=row.get("period") or ("FY" if period_type is PeriodType.ANNUAL else None),
            values=values,
        )
        derive_free_cash_flow(period)
        period.values.update(balance_sheet_near(balances, end))
        period.opening_balances = balance_sheet_near(balances, start - timedelta(days=1))
        periods.append(period)

    return FmpNormalized(periods=periods, currency=currency)
