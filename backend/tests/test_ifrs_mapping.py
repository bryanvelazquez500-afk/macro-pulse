"""IFRS (`ifrs-full`) filers and non-USD reporting currencies from SEC CompanyFacts."""

from app.services.forensics import compute_forensics
from app.services.gaap_mapping import (
    DERIVED_IFRS_LIABILITIES_TAG,
    IFRS,
    US_GAAP,
    Metric,
    ReportingBasis,
    detect_reporting_basis,
    normalize_company_facts,
)
from app.services.variance import compute_variances, find_prior_year_period

FY25 = ("2024-04-01", "2025-03-31")
FY24 = ("2023-04-01", "2024-03-31")


def _dur(val, start, end, fy, accn, form="20-F", filed=None):
    return {"val": val, "start": start, "end": end, "form": form, "filed": filed or f"{fy}-06-01", "fy": fy, "fp": "FY", "accn": accn}


def _inst(val, end, fy, accn, form="20-F", filed=None):
    return {"val": val, "end": end, "form": form, "filed": filed or f"{fy}-06-01", "fy": fy, "fp": "FY", "accn": accn}


def _ifrs(currency="EUR", **tags):
    return {"facts": {"ifrs-full": {tag: {"units": units if isinstance(units, dict) else {currency: units}} for tag, units in tags.items()}}}


def _vodafone_like():
    """Two fiscal years of a March year-end IFRS filer reporting in EUR, with a USD convenience translation."""
    a25, a24 = "V-25", "V-24"
    return _ifrs(
        Revenue=[_dur(37_400, *FY25, 2025, a25), _dur(36_700, *FY24, 2025, a25), _dur(36_700, *FY24, 2024, a24)],
        CostOfSales=[_dur(25_600, *FY25, 2025, a25), _dur(24_800, *FY24, 2024, a24)],
        ProfitLossFromOperatingActivities=[_dur(-400, *FY25, 2025, a25), _dur(3_700, *FY24, 2024, a24)],
        ProfitLossAttributableToOwnersOfParent=[_dur(-4_200, *FY25, 2025, a25), _dur(1_500, *FY24, 2024, a24)],
        # The USD figure is a convenience translation in the same filing — never mixed in.
        ProfitLoss={"EUR": [_dur(-3_700, *FY25, 2025, a25)], "USD": [_dur(-4_000, *FY25, 2025, a25)]},
        AdjustedWeightedAverageShares={"shares": [_dur(26_000, *FY25, 2025, a25), _dur(26_900, *FY24, 2024, a24)]},
        CashFlowsFromUsedInOperatingActivities=[_dur(15_300, *FY25, 2025, a25), _dur(15_200, *FY24, 2024, a24)],
        PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities=[_dur(6_800, *FY25, 2025, a25), _dur(6_900, *FY24, 2024, a24)],
        CashAndCashEquivalents=[_inst(9_000, "2025-03-31", 2025, a25), _inst(7_000, "2024-03-31", 2024, a24)],
        TradeAndOtherCurrentReceivables=[_inst(11_000, "2025-03-31", 2025, a25), _inst(10_500, "2024-03-31", 2024, a24)],
        Inventories=[_inst(800, "2025-03-31", 2025, a25), _inst(750, "2024-03-31", 2024, a24)],
        CurrentAssets=[_inst(30_000, "2025-03-31", 2025, a25), _inst(28_000, "2024-03-31", 2024, a24)],
        Assets=[_inst(130_000, "2025-03-31", 2025, a25), _inst(140_000, "2024-03-31", 2024, a24)],
        CurrentLiabilities=[_inst(29_000, "2025-03-31", 2025, a25), _inst(30_000, "2024-03-31", 2024, a24)],
        # No `Liabilities` tag: total liabilities must be derived from EquityAndLiabilities − Equity.
        EquityAndLiabilities=[_inst(130_000, "2025-03-31", 2025, a25), _inst(140_000, "2024-03-31", 2024, a24)],
        Equity=[_inst(55_000, "2025-03-31", 2025, a25), _inst(62_000, "2024-03-31", 2024, a24)],
        EquityAttributableToOwnersOfParent=[_inst(53_000, "2025-03-31", 2025, a25), _inst(60_000, "2024-03-31", 2024, a24)],
        RetainedEarnings=[_inst(-120_000, "2025-03-31", 2025, a25), _inst(-115_000, "2024-03-31", 2024, a24)],
        LongtermBorrowings=[_inst(40_000, "2025-03-31", 2025, a25), _inst(42_000, "2024-03-31", 2024, a24)],
    )


def test_detects_ifrs_and_the_majority_currency():
    assert detect_reporting_basis(_vodafone_like()) == ReportingBasis(IFRS, "EUR")


def test_detection_defaults_to_us_gaap_usd():
    assert detect_reporting_basis({"facts": {}}) == ReportingBasis(US_GAAP, "USD")


def test_maps_ifrs_statements_onto_internal_metrics():
    fy25, fy24 = normalize_company_facts(_vodafone_like())
    v = {m: x.value for m, x in fy25.values.items()}
    assert (fy25.fiscal_year, fy24.fiscal_year) == (2025, 2024)
    assert v[Metric.REVENUE] == 37_400
    assert v[Metric.NET_INCOME] == -4_200  # attributable to owners of the parent, not the USD translation
    assert v[Metric.DILUTED_SHARES] == 26_000
    assert v[Metric.FREE_CASH_FLOW] == 15_300 - 6_800
    assert v[Metric.STOCKHOLDERS_EQUITY] == 53_000
    assert v[Metric.TOTAL_LIABILITIES] == 130_000 - 55_000
    assert fy25.values[Metric.TOTAL_LIABILITIES].source_tag == DERIVED_IFRS_LIABILITIES_TAG
    assert fy25.values[Metric.REVENUE].source_tag == "ifrs-full:Revenue"
    assert fy25.opening_balances[Metric.TOTAL_ASSETS].value == 140_000


def test_variances_and_forensics_run_on_ifrs_periods():
    periods = normalize_company_facts(_vodafone_like())
    fy25 = periods[0]
    variance = compute_variances(periods, 0.10)[fy25.key]
    assert variance[Metric.NET_INCOME].flagged and variance[Metric.NET_INCOME].direction == "down"
    assert not variance[Metric.REVENUE].flagged  # +1.9%

    forensics = compute_forensics(fy25, find_prior_year_period(fy25, periods))
    assert forensics.piotroski is not None and forensics.piotroski.score is not None
    assert forensics.altman_z is not None and forensics.altman_z.value is not None
    assert forensics.sloan_accruals_pct is not None and forensics.sloan_accruals_pct.value is not None


def test_company_that_switched_to_ifrs_keeps_older_us_gaap_history():
    # Toyota-style: FY2024 under IFRS, FY2023 only under US GAAP — both in JPY.
    data = {
        "facts": {
            "ifrs-full": {"Revenue": {"units": {"JPY": [_dur(45, "2023-04-01", "2024-03-31", 2024, "T-24")]}}},
            "us-gaap": {"Revenues": {"units": {"JPY": [_dur(37, "2022-04-01", "2023-03-31", 2023, "T-23")]}}},
        }
    }
    assert detect_reporting_basis(data) == ReportingBasis(IFRS, "JPY")
    fy24, fy23 = normalize_company_facts(data)
    assert (fy24.values[Metric.REVENUE].source_tag, fy24.values[Metric.REVENUE].value) == ("ifrs-full:Revenue", 45)
    assert (fy23.values[Metric.REVENUE].source_tag, fy23.values[Metric.REVENUE].value) == ("Revenues", 37)


def test_forward_dated_facts_do_not_shift_the_fiscal_year():
    # Sanofi's FY2025 20-F also reports undrawn facilities as of 2026-12-31 (after it was filed).
    accn = "S-25"
    data = _ifrs(
        RevenueFromSaleOfGoods=[_dur(43, "2025-01-01", "2025-12-31", 2025, accn, filed="2026-02-17"),
                                _dur(41, "2024-01-01", "2024-12-31", 2025, accn, filed="2026-02-17")],
        UndrawnBorrowingFacilities=[_inst(8, "2026-12-31", 2025, accn, filed="2026-02-17")],
    )  # fmt: skip
    fy25, fy24 = normalize_company_facts(data)
    assert (fy25.fiscal_year, fy24.fiscal_year) == (2025, 2024)
    assert fy25.values[Metric.REVENUE].source_tag == "ifrs-full:RevenueFromSaleOfGoods"


def test_total_revenue_wins_over_sale_of_goods():
    span = ("2024-01-01", "2024-12-31")
    data = _ifrs(Revenue=[_dur(100, *span, 2024, "X")], RevenueFromSaleOfGoods=[_dur(70, *span, 2024, "X")])
    (fy24,) = normalize_company_facts(data)
    assert fy24.values[Metric.REVENUE].value == 100
