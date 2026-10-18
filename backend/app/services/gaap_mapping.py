"""Normalizes heterogeneous US-GAAP and IFRS XBRL tags into uniform internal metrics.

Companies report the same economic concept under different tags (and switch
tags over time — e.g. most filers moved from `SalesRevenueNet` to
`RevenueFromContractWithCustomerExcludingAssessedTax` after ASC 606 in 2018).
Each internal metric below lists candidate tags in priority order. For every
reporting period we take the value from the highest-priority tag that has data
for that period, so a company's history stays continuous across tag changes.

Income-statement facts are *durations* (start → end); balance-sheet facts are
*instants* (a single `end` date). Each income-statement period gets the
balance sheet as of its end date (closing) and as of its start (opening).

Foreign private issuers (20-F / 40-F filers such as Vodafone or SAP) tag their
statements with the IFRS taxonomy (`ifrs-full`) and report in their own currency
(EUR, GBP, JPY…); some, like ASML, use US GAAP in a foreign currency. Each company's
reporting basis — taxonomy and currency — is detected from its latest annual filing,
and only facts in that currency are used, so every period stays comparable.
IFRS tags are written qualified (`ifrs-full:Revenue`); bare names are US GAAP.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import StrEnum
from typing import Any, Iterable


class Metric(StrEnum):
    # Income statement
    REVENUE = "revenue"
    COST_OF_GOODS_SOLD = "cost_of_goods_sold"
    OPERATING_INCOME = "operating_income"
    NET_INCOME = "net_income"
    PRETAX_INCOME = "pretax_income"
    INCOME_TAX_EXPENSE = "income_tax_expense"
    DIVIDENDS_PAID = "dividends_paid"  # cash dividends to common shareholders (positive outflow)
    SGA_EXPENSE = "sga_expense"  # selling, general & administrative; summed from components when not tagged
    DILUTED_SHARES = "diluted_shares"  # weighted-average diluted shares (unit: shares, not USD)
    # Cash flow statement
    OPERATING_CASH_FLOW = "operating_cash_flow"
    CAPITAL_EXPENDITURES = "capital_expenditures"
    FREE_CASH_FLOW = "free_cash_flow"  # derived: operating cash flow − capex
    # Balance sheet
    CASH_AND_EQUIVALENTS = "cash_and_equivalents"
    SHORT_TERM_INVESTMENTS = "short_term_investments"
    ACCOUNTS_RECEIVABLE = "accounts_receivable"
    INVENTORY = "inventory"
    CURRENT_ASSETS = "current_assets"
    TOTAL_ASSETS = "total_assets"
    CURRENT_LIABILITIES = "current_liabilities"
    TOTAL_LIABILITIES = "total_liabilities"
    STOCKHOLDERS_EQUITY = "stockholders_equity"
    RETAINED_EARNINGS = "retained_earnings"
    LONG_TERM_DEBT = "long_term_debt"
    GOODWILL_AND_INTANGIBLES = "goodwill_and_intangibles"  # for tangible book value (equity − this)


class PeriodType(StrEnum):
    ANNUAL = "annual"
    QUARTERLY = "quarterly"


INCOME_STATEMENT_TAG_MAP: dict[Metric, list[str]] = {
    Metric.REVENUE: [
        "Revenues",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet",
        "RevenuesNetOfInterestExpense",
        "RevenueNet",
    ],
    Metric.COST_OF_GOODS_SOLD: [
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
        "CostOfServices",
        "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
        "CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization",
    ],
    Metric.OPERATING_INCOME: [
        "OperatingIncomeLoss",
    ],
    Metric.NET_INCOME: [
        "NetIncomeLoss",
        "ProfitLoss",
        "NetIncomeLossAvailableToCommonStockholdersBasic",
    ],
    # Pre-tax income and tax give the effective tax rate used for ROIC's NOPAT.
    Metric.PRETAX_INCOME: [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    Metric.INCOME_TAX_EXPENSE: [
        "IncomeTaxExpenseBenefit",
    ],
    Metric.DIVIDENDS_PAID: [
        "PaymentsOfDividendsCommonStock",
        "PaymentsOfOrdinaryDividends",
        "PaymentsOfDividends",
    ],
    Metric.SGA_EXPENSE: [
        "SellingGeneralAndAdministrativeExpense",
        # Otherwise derived from selling + administrative components — see _derive_sga.
    ],
    Metric.DILUTED_SHARES: [
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ],
    # Cash-flow facts are durations too, so they normalize alongside the income statement.
    # Note: 10-Qs report cash flows year-to-date, so most single quarters have none.
    Metric.OPERATING_CASH_FLOW: [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    Metric.CAPITAL_EXPENDITURES: [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
        "PaymentsToAcquireOtherProductiveAssets",  # Verizon: capex including capitalized software
    ],
}

BALANCE_SHEET_TAG_MAP: dict[Metric, list[str]] = {
    Metric.CASH_AND_EQUIVALENTS: [
        "CashAndCashEquivalentsAtCarryingValue",
        "Cash",
    ],
    Metric.SHORT_TERM_INVESTMENTS: [
        "ShortTermInvestments",
        "MarketableSecuritiesCurrent",
        "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
        "AvailableForSaleSecuritiesCurrent",
    ],
    Metric.ACCOUNTS_RECEIVABLE: [
        "AccountsReceivableNetCurrent",
        "ReceivablesNetCurrent",
    ],
    Metric.INVENTORY: [
        "InventoryNet",
    ],
    Metric.CURRENT_ASSETS: [
        "AssetsCurrent",
    ],
    Metric.TOTAL_ASSETS: [
        "Assets",
    ],
    Metric.CURRENT_LIABILITIES: [
        "LiabilitiesCurrent",
    ],
    Metric.TOTAL_LIABILITIES: [
        "Liabilities",
        # Many filers never tag total liabilities; it's then derived — see _derive_total_liabilities.
    ],
    Metric.STOCKHOLDERS_EQUITY: [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    Metric.RETAINED_EARNINGS: [
        "RetainedEarningsAccumulatedDeficit",
    ],
    Metric.LONG_TERM_DEBT: [
        "LongTermDebtNoncurrent",
        "LongTermDebtAndCapitalLeaseObligations",
        "LongTermDebt",
    ],
    Metric.GOODWILL_AND_INTANGIBLES: [
        "IntangibleAssetsNetIncludingGoodwill",
        # Otherwise Goodwill + IntangibleAssetsNetExcludingGoodwill — see _derive_goodwill_and_intangibles.
    ],
}

US_GAAP = "us-gaap"
IFRS = "ifrs-full"
STANDARD_LABELS = {US_GAAP: "US GAAP", IFRS: "IFRS"}

# IFRS equivalents, chosen by how many of ~35 large IFRS filers on EDGAR (Vodafone, SAP, Novartis,
# Shell, Toyota, HSBC…) report each tag. Deliberately excluded: `ifrs-full:Borrowings` (total,
# not long-term, debt).
IFRS_INCOME_STATEMENT_TAG_MAP: dict[Metric, list[str]] = {
    Metric.REVENUE: [
        "ifrs-full:Revenue",
        "ifrs-full:RevenueFromContractsWithCustomers",
        "ifrs-full:RevenueAndOperatingIncome",  # banks' total operating income
        # Last resort: usually a component of revenue, but pharma groups (Novartis, Sanofi) tag their
        # entire "net sales" top line with it and report no total Revenue.
        "ifrs-full:RevenueFromSaleOfGoods",
    ],
    Metric.COST_OF_GOODS_SOLD: ["ifrs-full:CostOfSales"],
    Metric.OPERATING_INCOME: ["ifrs-full:ProfitLossFromOperatingActivities"],
    Metric.NET_INCOME: [
        "ifrs-full:ProfitLossAttributableToOwnersOfParent",
        "ifrs-full:ProfitLoss",
    ],
    Metric.PRETAX_INCOME: ["ifrs-full:ProfitLossBeforeTax"],
    Metric.INCOME_TAX_EXPENSE: ["ifrs-full:IncomeTaxExpenseContinuingOperations"],
    Metric.SGA_EXPENSE: ["ifrs-full:SellingGeneralAndAdministrativeExpense"],
    Metric.DIVIDENDS_PAID: [
        "ifrs-full:DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities",
        "ifrs-full:DividendsPaidClassifiedAsFinancingActivities",
        "ifrs-full:DividendsPaid",
    ],
    Metric.DILUTED_SHARES: ["ifrs-full:AdjustedWeightedAverageShares"],
    Metric.OPERATING_CASH_FLOW: [
        "ifrs-full:CashFlowsFromUsedInOperatingActivities",
        "ifrs-full:CashFlowsFromUsedInOperatingActivitiesContinuingOperations",
    ],
    Metric.CAPITAL_EXPENDITURES: [
        "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        "ifrs-full:PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
    ],
}

IFRS_BALANCE_SHEET_TAG_MAP: dict[Metric, list[str]] = {
    Metric.CASH_AND_EQUIVALENTS: ["ifrs-full:CashAndCashEquivalents"],
    Metric.SHORT_TERM_INVESTMENTS: [
        "ifrs-full:CurrentInvestments",
        "ifrs-full:ShorttermDepositsNotClassifiedAsCashEquivalents",
        "ifrs-full:OtherCurrentFinancialAssets",
    ],
    Metric.ACCOUNTS_RECEIVABLE: [
        "ifrs-full:TradeAndOtherCurrentReceivables",
        "ifrs-full:CurrentTradeReceivables",
    ],
    Metric.INVENTORY: ["ifrs-full:Inventories"],
    Metric.CURRENT_ASSETS: ["ifrs-full:CurrentAssets"],
    Metric.TOTAL_ASSETS: ["ifrs-full:Assets"],
    Metric.CURRENT_LIABILITIES: ["ifrs-full:CurrentLiabilities"],
    Metric.TOTAL_LIABILITIES: ["ifrs-full:Liabilities"],
    Metric.STOCKHOLDERS_EQUITY: [
        "ifrs-full:EquityAttributableToOwnersOfParent",
        "ifrs-full:Equity",
    ],
    Metric.RETAINED_EARNINGS: ["ifrs-full:RetainedEarnings"],
    Metric.LONG_TERM_DEBT: [
        "ifrs-full:LongtermBorrowings",
        "ifrs-full:NoncurrentPortionOfNoncurrentBondsIssued",
    ],
    # Toyota, HSBC, TSMC and Equinor report only this combined line.
    Metric.GOODWILL_AND_INTANGIBLES: ["ifrs-full:IntangibleAssetsAndGoodwill"],
}

# Monetary metrics use the company's reporting currency; these don't.
METRIC_UNITS: dict[Metric, str] = {Metric.DILUTED_SHARES: "shares"}

GAAP_TAG_MAP: dict[Metric, list[str]] = {**INCOME_STATEMENT_TAG_MAP, **BALANCE_SHEET_TAG_MAP}
IFRS_TAG_MAP: dict[Metric, list[str]] = {**IFRS_INCOME_STATEMENT_TAG_MAP, **IFRS_BALANCE_SHEET_TAG_MAP}
_TAG_MAPS = {US_GAAP: (INCOME_STATEMENT_TAG_MAP, BALANCE_SHEET_TAG_MAP), IFRS: (IFRS_INCOME_STATEMENT_TAG_MAP, IFRS_BALANCE_SHEET_TAG_MAP)}

DERIVED_LIABILITIES_TAG = "LiabilitiesAndStockholdersEquity − Equity (derived)"
DERIVED_IFRS_LIABILITIES_TAG = "ifrs-full:EquityAndLiabilities − Equity (derived)"
# (total of liabilities and equity, equity tags in priority order, label) per taxonomy
_LIABILITY_DERIVATIONS = {
    US_GAAP: (
        "LiabilitiesAndStockholdersEquity",
        ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "StockholdersEquity"],
        DERIVED_LIABILITIES_TAG,
    ),
    IFRS: ("ifrs-full:EquityAndLiabilities", ["ifrs-full:Equity"], DERIVED_IFRS_LIABILITIES_TAG),
}
DERIVED_FCF_TAG = "OperatingCashFlow − CapitalExpenditures (derived)"
DERIVED_SGA_TAG = "Selling + Administrative expense components (derived)"
DERIVED_GOODWILL_TAG = "Goodwill + intangible assets (derived)"
# (goodwill tag, other-intangibles tag) per taxonomy, summed when no combined line is reported.
# Other intangibles: the all-in tag, else finite-lived + indefinite-lived (Coca-Cola reports its $12.5B of
# trademarks only as IndefiniteLivedTrademarks, separate from finite-lived intangibles).
_GOODWILL_PARTS = {
    US_GAAP: (
        "Goodwill",
        [["IntangibleAssetsNetExcludingGoodwill"], ["FiniteLivedIntangibleAssetsNet"],
         ["IndefiniteLivedIntangibleAssetsExcludingGoodwill", "IndefiniteLivedTrademarks"]],
    ),
    IFRS: ("ifrs-full:Goodwill", [["ifrs-full:IntangibleAssetsOtherThanGoodwill"]]),
}  # fmt: skip

# Companies that split SG&A (Microsoft, Alphabet, SAP…) report a selling line and an administrative
# line. SG&A is derived only when both kinds exist for a period — a lone admin line would understate it.
_SGA_SELLING_TAGS = [
    "SellingAndMarketingExpense",
    "SellingExpense",
    "ifrs-full:SalesAndMarketingExpense",
    "ifrs-full:SellingExpense",
]
_SGA_DISTRIBUTION_TAGS = ["ifrs-full:DistributionCosts"]  # added on top of selling when reported separately
_SGA_ADMIN_TAGS = [
    "GeneralAndAdministrativeExpense",
    "ifrs-full:AdministrativeExpense",
    "ifrs-full:GeneralAndAdministrativeExpense",
]

_ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
_QUARTERLY_FORMS = {"10-Q", "10-Q/A"}

# Duration windows (days) used to tell a full fiscal year from a single quarter,
# since a 10-Q also carries year-to-date figures we don't want.
_ANNUAL_DAYS = range(350, 380)
_QUARTER_DAYS = range(80, 100)

# Balance-sheet dates may sit a few days off a period boundary (52/53-week years).
_BALANCE_SHEET_DATE_TOLERANCE_DAYS = 7


@dataclass(frozen=True)
class ReportingBasis:
    standard: str  # US_GAAP | IFRS — tried first; the other taxonomy only fills gaps
    currency: str  # ISO 4217 code of the monetary facts used


DEFAULT_BASIS = ReportingBasis(US_GAAP, "USD")


def _merge_tag_maps(*maps: dict[Metric, list[str]]) -> dict[Metric, list[str]]:
    merged: dict[Metric, list[str]] = {}
    for tag_map in maps:
        for metric, tags in tag_map.items():
            merged.setdefault(metric, []).extend(tags)
    return merged


def ordered_tag_maps(basis: ReportingBasis) -> tuple[dict[Metric, list[str]], dict[Metric, list[str]]]:
    """(duration, balance-sheet) tag maps with the company's own standard first.

    Companies that switched standards (Toyota moved from US GAAP to IFRS) keep a continuous
    history: older periods only exist under the other taxonomy, so they fill in from it.
    """
    primary = _TAG_MAPS[basis.standard]
    secondary = _TAG_MAPS[IFRS if basis.standard == US_GAAP else US_GAAP]
    return _merge_tag_maps(primary[0], secondary[0]), _merge_tag_maps(primary[1], secondary[1])


def tag_map_for(basis: ReportingBasis) -> dict[Metric, list[str]]:
    durations, balances = ordered_tag_maps(basis)
    return {**durations, **balances}


@dataclass(frozen=True)
class NormalizedValue:
    value: float
    source_tag: str
    accession_number: str | None  # None for non-EDGAR sources
    form: str
    filed: str


@dataclass
class NormalizedPeriod:
    period_type: PeriodType
    start: str
    end: str
    fiscal_year: int | None
    fiscal_period: str | None
    # Income-statement values for the period plus the closing balance sheet.
    values: dict[Metric, NormalizedValue]
    # Balance sheet as of the start of the period (prior period's close).
    opening_balances: dict[Metric, NormalizedValue] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        return self.start, self.end


def _duration_days(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def _matches_period_type(fact: dict[str, Any], period_type: PeriodType) -> bool:
    start, end, form = fact.get("start"), fact.get("end"), fact.get("form")
    if not start or not end:
        return False  # instant facts (balance sheet) are handled separately
    days = _duration_days(start, end)
    if period_type is PeriodType.ANNUAL:
        return form in _ANNUAL_FORMS and days in _ANNUAL_DAYS
    return form in _QUARTERLY_FORMS and days in _QUARTER_DAYS


def _split_tag(tag: str) -> tuple[str, str]:
    taxonomy, _, name = tag.rpartition(":")
    return taxonomy or US_GAAP, name


def _unit_facts(company_facts: dict[str, Any], tag: str, unit: str = "USD") -> list[dict[str, Any]]:
    taxonomy, name = _split_tag(tag)
    concept = company_facts.get("facts", {}).get(taxonomy, {}).get(name)
    if not concept:
        return []
    return concept.get("units", {}).get(unit, [])


def _is_currency_unit(unit: str) -> bool:
    # Monetary units are ISO codes ("EUR"); per-share and count units look like "EUR/shares", "shares", "pure".
    return len(unit) == 3 and unit.isalpha() and unit.isupper()


_BASIS_PROBE_METRICS = (Metric.REVENUE, Metric.NET_INCOME, Metric.TOTAL_ASSETS, Metric.STOCKHOLDERS_EQUITY, Metric.OPERATING_CASH_FLOW)


def detect_reporting_basis(company_facts: dict[str, Any]) -> ReportingBasis:
    """Taxonomy and currency of the company's most recently filed annual (else any) report.

    Within that filing the currency with the most headline facts wins, so the USD
    "convenience translations" some foreign filers add beside their real figures are ignored.
    """
    # (filed, is_annual, taxonomy, accession) → currency → count
    filings: dict[tuple[str, bool, str, str], Counter[str]] = {}
    for metric in _BASIS_PROBE_METRICS:
        for tag in GAAP_TAG_MAP[metric] + IFRS_TAG_MAP[metric]:
            taxonomy, name = _split_tag(tag)
            concept = company_facts.get("facts", {}).get(taxonomy, {}).get(name, {})
            for unit, facts in concept.get("units", {}).items():
                if not _is_currency_unit(unit):
                    continue
                for fact in facts:
                    form, accn = fact.get("form"), fact.get("accn")
                    if form in _ANNUAL_FORMS | _QUARTERLY_FORMS and accn and fact.get("filed"):
                        key = (fact["filed"], form in _ANNUAL_FORMS, taxonomy, accn)
                        filings.setdefault(key, Counter())[unit] += 1
    if not filings:
        return DEFAULT_BASIS
    # Prefer annual reports, then the latest filing, then the taxonomy with more headline facts.
    (_, _, taxonomy, _), currencies = max(filings.items(), key=lambda kv: (kv[0][1], kv[0][0], kv[1].total()))
    return ReportingBasis(taxonomy, currencies.most_common(1)[0][0])


def _latest(facts: list[dict[str, Any]], tag: str) -> NormalizedValue:
    # The most recently filed value picks up any restatement.
    fact = max(facts, key=lambda f: f["filed"])
    return NormalizedValue(
        value=float(fact["val"]),
        source_tag=tag,
        accession_number=fact["accn"],
        form=fact["form"],
        filed=fact["filed"],
    )


def _filing_period_ends(company_facts: dict[str, Any]) -> dict[str, str]:
    """Maps each accession number to the latest period end it reports.

    That date is the filing's own (current) period; anything earlier in the same
    filing is a prior-period comparative. Forward-dated facts (e.g. borrowing facilities
    available at a future date, as in Sanofi's 20-F) are ignored: a filing can't report a
    period that ends after it was filed.
    """
    ends: dict[str, str] = {}
    # Not `dei`: its cover-page facts are dated after the reporting period.
    for taxonomy in (US_GAAP, IFRS):
        for concept in company_facts.get("facts", {}).get(taxonomy, {}).values():
            for facts in concept.get("units", {}).values():
                for fact in facts:
                    accn, end = fact.get("accn"), fact.get("end")
                    if accn and end and end <= fact.get("filed", end) and end > ends.get(accn, ""):
                        ends[accn] = end
    return ends


def _fiscal_label(facts: list[dict[str, Any]], filing_ends: dict[str, str]) -> tuple[int | None, str | None]:
    """Determines a period's fiscal year/period.

    A fact's `fy`/`fp` describe the filing that contained it, not the period
    itself, so prior-year comparatives carry the wrong year. Prefer a fact from
    the filing where this period was the current one; otherwise back the year
    out from how far the period sits before that filing's own period.
    """
    by_filed = sorted(facts, key=lambda f: f["filed"])
    for fact in by_filed:
        if filing_ends.get(fact["accn"]) == fact["end"] and fact.get("fy"):
            return fact["fy"], fact.get("fp")
    for fact in by_filed:
        filing_end = filing_ends.get(fact["accn"])
        if fact.get("fy") and filing_end:
            years_back = round(_duration_days(fact["end"], filing_end) / 365.25)
            return fact["fy"] - years_back, fact.get("fp")
    return None, None


def _group_by_period(facts: Iterable[dict[str, Any]], period_type: PeriodType) -> dict[tuple[str, str], list[dict]]:
    """The same period is re-reported in later filings as a comparative figure."""
    by_period: dict[tuple[str, str], list[dict]] = {}
    for fact in facts:
        if _matches_period_type(fact, period_type):
            by_period.setdefault((fact["start"], fact["end"]), []).append(fact)
    return by_period


def _instants_by_date(company_facts: dict[str, Any], tag: str, unit: str) -> dict[str, list[dict]]:
    by_date: dict[str, list[dict]] = {}
    for fact in _unit_facts(company_facts, tag, unit):
        if fact.get("start") or not fact.get("end"):
            continue
        if fact.get("form") not in _ANNUAL_FORMS | _QUARTERLY_FORMS:
            continue
        by_date.setdefault(fact["end"], []).append(fact)
    return by_date


def _derive_total_liabilities(
    company_facts: dict[str, Any], balances: dict[str, dict[Metric, NormalizedValue]], basis: ReportingBasis
) -> None:
    """Total liabilities = (Liabilities + Equity) − Equity, when not tagged directly.

    Equity including noncontrolling interest is subtracted when available so the
    result doesn't absorb minority interest into liabilities (IFRS `Equity` already includes it).
    """
    total_tag, equity_tags, label = _LIABILITY_DERIVATIONS[basis.standard]
    totals = _instants_by_date(company_facts, total_tag, basis.currency)
    equities = [_instants_by_date(company_facts, tag, basis.currency) for tag in equity_tags]

    for end, total_facts in totals.items():
        values = balances.setdefault(end, {})
        if Metric.TOTAL_LIABILITIES in values:
            continue
        equity_facts = next((e[end] for e in equities if e.get(end)), None)
        if not equity_facts:
            continue
        total, eq = _latest(total_facts, ""), _latest(equity_facts, "")
        values[Metric.TOTAL_LIABILITIES] = NormalizedValue(
            value=total.value - eq.value,
            source_tag=label,
            accession_number=total.accession_number,
            form=total.form,
            filed=total.filed,
        )


def normalize_balance_sheets(
    company_facts: dict[str, Any], basis: ReportingBasis = DEFAULT_BASIS
) -> dict[str, dict[Metric, NormalizedValue]]:
    """Returns {balance-sheet date: {metric: value}} across every annual/quarterly report."""
    balances: dict[str, dict[Metric, NormalizedValue]] = {}
    for metric, tags in ordered_tag_maps(basis)[1].items():
        for tag in tags:
            for end, facts in _instants_by_date(company_facts, tag, basis.currency).items():
                values = balances.setdefault(end, {})
                if metric not in values:
                    values[metric] = _latest(facts, tag)
    _derive_total_liabilities(company_facts, balances, basis)
    _derive_goodwill_and_intangibles(company_facts, balances, basis)
    return balances


def _derive_goodwill_and_intangibles(
    company_facts: dict[str, Any], balances: dict[str, dict[Metric, NormalizedValue]], basis: ReportingBasis
) -> None:
    """Goodwill + other intangibles when no combined line is tagged; either part alone counts (a company
    with goodwill but no separately tagged intangibles still has that goodwill)."""
    goodwill_tag, groups = _GOODWILL_PARTS[basis.standard]
    goodwill = _instants_by_date(company_facts, goodwill_tag, basis.currency)
    # Each group is alternatives (first tag with data wins); the all-in group, if present, replaces the rest.
    group_facts = [[(t, _instants_by_date(company_facts, t, basis.currency)) for t in group] for group in groups]
    dates = set(goodwill) | {d for group in group_facts for _, m in group for d in m}
    for end in dates:
        values = balances.setdefault(end, {})
        if Metric.GOODWILL_AND_INTANGIBLES in values:
            continue
        parts = [_latest(goodwill[end], goodwill_tag)] if end in goodwill else []
        found = [next((_latest(m[end], t) for t, m in group if end in m), None) for group in group_facts]
        if found[0] is not None:  # the all-in intangibles tag
            parts.append(found[0])
        else:
            parts.extend(f for f in found[1:] if f is not None)
        values[Metric.GOODWILL_AND_INTANGIBLES] = NormalizedValue(
            value=sum(p.value for p in parts),
            source_tag=DERIVED_GOODWILL_TAG,
            accession_number=parts[0].accession_number,
            form=parts[0].form,
            filed=parts[0].filed,
        )


def balance_sheet_near(balances: dict[str, dict[Metric, NormalizedValue]], target: date) -> dict[Metric, NormalizedValue]:
    best: tuple[int, str] | None = None
    for end in balances:
        gap = abs((date.fromisoformat(end) - target).days)
        if gap <= _BALANCE_SHEET_DATE_TOLERANCE_DAYS and (best is None or gap < best[0]):
            best = (gap, end)
    return dict(balances[best[1]]) if best else {}


_YTD_CASH_FLOW_METRICS = (Metric.OPERATING_CASH_FLOW, Metric.CAPITAL_EXPENDITURES, Metric.DIVIDENDS_PAID)
YTD_DIFFERENCE_SUFFIX = " (year-to-date − prior year-to-date)"


def _derive_quarterly_cash_flows(
    company_facts: dict[str, Any], periods: dict[tuple[str, str], NormalizedPeriod], tag_map: dict[Metric, list[str]], currency: str
) -> None:
    """Single-quarter cash flows from 10-Q year-to-date figures: Q3 = 9-month YTD − 6-month YTD.

    10-Qs report the cash flow statement year-to-date only, so without this Q2 and Q3 have no cash flows.
    """
    for metric in _YTD_CASH_FLOW_METRICS:
        for tag in tag_map.get(metric, []):
            by_span: dict[tuple[str, str], dict[str, Any]] = {}
            for fact in _unit_facts(company_facts, tag, currency):
                if fact.get("start") and fact.get("end") and fact.get("form") in _QUARTERLY_FORMS | _ANNUAL_FORMS:
                    key = (fact["start"], fact["end"])
                    if key not in by_span or fact["filed"] > by_span[key]["filed"]:
                        by_span[key] = fact
            for period in periods.values():
                if metric in period.values:
                    continue
                q_start = date.fromisoformat(period.start)
                for (ytd_start, ytd_end), ytd in by_span.items():
                    if ytd_end != period.end or date.fromisoformat(ytd_start) >= q_start - timedelta(days=30):
                        continue
                    prior = next(
                        (f for (s2, e2), f in by_span.items()
                         if s2 == ytd_start and 0 < (q_start - date.fromisoformat(e2)).days <= 7),
                        None,
                    )  # fmt: skip
                    if prior is not None:
                        period.values[metric] = NormalizedValue(
                            value=float(ytd["val"]) - float(prior["val"]),
                            source_tag=tag + YTD_DIFFERENCE_SUFFIX,
                            accession_number=ytd["accn"],
                            form=ytd["form"],
                            filed=ytd["filed"],
                        )
                        break


def derive_free_cash_flow(period: NormalizedPeriod) -> None:
    ocf = period.values.get(Metric.OPERATING_CASH_FLOW)
    if ocf is None:
        return
    capex = period.values.get(Metric.CAPITAL_EXPENDITURES)
    if capex is None:
        # A missing capex tag far more often means an unmapped tag than zero spending (Verizon's
        # $17B was under PaymentsToAcquireOtherProductiveAssets): no FCF beats an inflated one.
        return
    # Capex is tagged as a positive outflow.
    period.values[Metric.FREE_CASH_FLOW] = NormalizedValue(
        value=ocf.value - capex.value,
        source_tag=DERIVED_FCF_TAG,
        accession_number=ocf.accession_number,
        form=ocf.form,
        filed=ocf.filed,
    )


_SPLIT_RATIO_TOLERANCE = 0.02
_SPLIT_CLUSTER_DAYS = 400


def _split_like(ratio: float) -> bool:
    """3-for-2, 2-for-1, 10-for-1 … (or the reverse), within 2%."""
    for r in (ratio, 1 / ratio):
        if r >= 1.45:
            nearest = 1.5 if abs(r - 1.5) / 1.5 <= _SPLIT_RATIO_TOLERANCE else round(r)
            if nearest >= 1.5 and abs(r - nearest) / nearest <= _SPLIT_RATIO_TOLERANCE:
                return True
    return False


def detect_share_splits(company_facts: dict[str, Any], tags: list[str]) -> list[tuple[str, float]]:
    """[(first filing date on the new basis, ratio)] for each stock split (or share-count rescaling).

    Filings restate prior-period share counts after a split, so the same period appears with a
    pre-split value in an older filing and a post-split value in a newer one; their ratio is the
    split ratio (NVIDIA 4:1 in 2021, Amazon 20:1 in 2022). Detecting it from the data avoids
    needing a split calendar.
    """
    events: list[tuple[str, float]] = []
    for tag in tags:
        by_period: dict[tuple[str, str], list[dict]] = {}
        for fact in _unit_facts(company_facts, tag, "shares"):
            if fact.get("start") and fact.get("val") and fact.get("filed"):
                by_period.setdefault((fact["start"], fact["end"]), []).append(fact)
        for facts in by_period.values():
            facts.sort(key=lambda f: f["filed"])
            for older, newer in zip(facts, facts[1:]):
                ratio = newer["val"] / older["val"]
                if _split_like(ratio):
                    events.append((newer["filed"], ratio))

    # Many restated periods reveal the same split: keep the earliest filing date per split.
    splits: list[tuple[str, float, str]] = []  # (first filed, ratio, last filed)
    for filed, ratio in sorted(events):
        last = splits[-1] if splits else None
        if (
            last
            and abs(ratio / last[1] - 1) <= _SPLIT_RATIO_TOLERANCE
            and _duration_days(last[2], filed) <= _SPLIT_CLUSTER_DAYS
        ):
            splits[-1] = (last[0], last[1], filed)
        else:
            splits.append((filed, ratio, filed))
    return [(first, ratio) for first, ratio, _ in splits]


def _adjust_for_splits(periods: Iterable[NormalizedPeriod], splits: list[tuple[str, float]]) -> None:
    """Restates diluted shares filed before a split onto today's share basis."""
    for period in periods:
        shares = period.values.get(Metric.DILUTED_SHARES)
        if shares is None:
            continue
        factor = 1.0
        for split_filed, ratio in splits:
            if shares.filed < split_filed:
                factor *= ratio
        if factor != 1.0:
            period.values[Metric.DILUTED_SHARES] = NormalizedValue(
                value=shares.value * factor,
                source_tag=f"{shares.source_tag} (split-adjusted ×{factor:g})",
                accession_number=shares.accession_number,
                form=shares.form,
                filed=shares.filed,
            )


def _derive_sga(company_facts: dict[str, Any], periods: dict[tuple[str, str], NormalizedPeriod], basis: ReportingBasis) -> None:
    def by_period(tags: list[str]) -> list[dict[tuple[str, str], list[dict]]]:
        return [_group_by_period(_unit_facts(company_facts, t, basis.currency), periods_type) for t in tags]

    if not periods:
        return
    periods_type = next(iter(periods.values())).period_type
    selling, distribution, admin = by_period(_SGA_SELLING_TAGS), by_period(_SGA_DISTRIBUTION_TAGS), by_period(_SGA_ADMIN_TAGS)

    def first(groups: list[dict[tuple[str, str], list[dict]]], key: tuple[str, str]) -> NormalizedValue | None:
        return next((_latest(g[key], "") for g in groups if key in g), None)

    for key, period in periods.items():
        if Metric.SGA_EXPENSE in period.values:
            continue
        sell, adm = first(selling, key), first(admin, key)
        if sell is None or adm is None:
            continue
        dist = first(distribution, key)
        period.values[Metric.SGA_EXPENSE] = NormalizedValue(
            value=sell.value + adm.value + (dist.value if dist else 0),
            source_tag=DERIVED_SGA_TAG,
            accession_number=sell.accession_number,
            form=sell.form,
            filed=sell.filed,
        )


def normalize_company_facts(
    company_facts: dict[str, Any],
    period_type: PeriodType = PeriodType.ANNUAL,
    basis: ReportingBasis | None = None,
) -> list[NormalizedPeriod]:
    """Returns standardized periods (income statement + balance sheets) sorted newest first."""
    basis = basis or detect_reporting_basis(company_facts)
    tag_map = ordered_tag_maps(basis)[0]
    filing_ends = _filing_period_ends(company_facts)
    periods: dict[tuple[str, str], NormalizedPeriod] = {}
    period_facts: dict[tuple[str, str], list[dict]] = {}

    for metric, tags in tag_map.items():
        # Walk tags in priority order; a lower-priority tag only fills periods
        # that no higher-priority tag has already covered.
        for tag in tags:
            unit = METRIC_UNITS.get(metric, basis.currency)
            for key, facts in _group_by_period(_unit_facts(company_facts, tag, unit), period_type).items():
                period_facts.setdefault(key, []).extend(facts)
                period = periods.setdefault(
                    key,
                    NormalizedPeriod(period_type=period_type, start=key[0], end=key[1], fiscal_year=None, fiscal_period=None, values={}),
                )
                if metric not in period.values:
                    period.values[metric] = _latest(facts, tag)

    _adjust_for_splits(periods.values(), detect_share_splits(company_facts, tag_map[Metric.DILUTED_SHARES]))
    _derive_sga(company_facts, periods, basis)
    if period_type is PeriodType.QUARTERLY:
        _derive_quarterly_cash_flows(company_facts, periods, tag_map, basis.currency)
    balances = normalize_balance_sheets(company_facts, basis)
    for key, period in periods.items():
        derive_free_cash_flow(period)
        period.fiscal_year, period.fiscal_period = _fiscal_label(period_facts[key], filing_ends)
        period.values.update(balance_sheet_near(balances, date.fromisoformat(period.end)))
        period.opening_balances = balance_sheet_near(balances, date.fromisoformat(period.start) - timedelta(days=1))

    return sorted(periods.values(), key=lambda p: p.end, reverse=True)
