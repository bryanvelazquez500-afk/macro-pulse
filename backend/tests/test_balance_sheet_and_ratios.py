import pytest

from app.services.gaap_mapping import DERIVED_LIABILITIES_TAG, Metric, PeriodType, normalize_company_facts
from app.services.ratios import RatioKey, compute_ratios

FY23 = ("2023-01-01", "2023-12-31")


def _dur(val, start, end, form="10-K", accn="A-23", filed="2024-02-01", fy=2023, fp="FY"):
    return {"val": val, "start": start, "end": end, "form": form, "filed": filed, "fy": fy, "fp": fp, "accn": accn}


def _inst(val, end, form="10-K", accn="A-23", filed="2024-02-01", fy=2023, fp="FY"):
    return {"val": val, "end": end, "form": form, "filed": filed, "fy": fy, "fp": fp, "accn": accn}


def _facts(**tags):
    return {"facts": {"us-gaap": {tag: {"units": {"USD": facts}} for tag, facts in tags.items()}}}


def _company(**overrides):
    tags = dict(
        Revenues=[_dur(1000, *FY23)],
        CostOfRevenue=[_dur(600, *FY23)],
        OperatingIncomeLoss=[_dur(200, *FY23)],
        NetIncomeLoss=[_dur(150, *FY23)],
        CashAndCashEquivalentsAtCarryingValue=[_inst(100, "2023-12-31")],
        ShortTermInvestments=[_inst(50, "2023-12-31")],
        AccountsReceivableNetCurrent=[_inst(150, "2023-12-31")],
        InventoryNet=[_inst(200, "2023-12-31")],
        AssetsCurrent=[_inst(600, "2023-12-31")],
        LiabilitiesCurrent=[_inst(400, "2023-12-31")],
        Assets=[_inst(1800, "2022-12-31", accn="A-22", filed="2023-02-01", fy=2022), _inst(2200, "2023-12-31")],
        Liabilities=[_inst(1200, "2023-12-31")],
        StockholdersEquity=[_inst(1000, "2023-12-31")],
    )
    tags.update(overrides)
    return _facts(**{k: v for k, v in tags.items() if v is not None})


def _ratios(data):
    (period,) = normalize_company_facts(data, PeriodType.ANNUAL)
    return period, compute_ratios(period)


def test_balance_sheet_attaches_at_period_end_and_start():
    period, _ = _ratios(_company())
    assert period.values[Metric.TOTAL_ASSETS].value == 2200
    assert period.values[Metric.CURRENT_LIABILITIES].value == 400
    assert period.opening_balances[Metric.TOTAL_ASSETS].value == 1800


def test_audit_ratios():
    _, r = _ratios(_company())
    assert r[RatioKey.CURRENT_RATIO].value == pytest.approx(1.5)  # 600 / 400
    assert r[RatioKey.QUICK_RATIO].value == pytest.approx(0.75)  # (100 + 50 + 150) / 400
    assert r[RatioKey.DEBT_TO_EQUITY].value == pytest.approx(1.2)  # 1200 / 1000
    assert r[RatioKey.OPERATING_MARGIN_PCT].value == pytest.approx(20.0)  # 200 / 1000
    assert r[RatioKey.GROSS_MARGIN_PCT].value == pytest.approx(40.0)
    assert r[RatioKey.NET_MARGIN_PCT].value == pytest.approx(15.0)
    assert r[RatioKey.ASSET_TURNOVER].value == pytest.approx(0.5)  # 1000 / avg(1800, 2200)


def test_quick_ratio_falls_back_to_current_assets_less_inventory():
    _, r = _ratios(_company(CashAndCashEquivalentsAtCarryingValue=None))
    assert r[RatioKey.QUICK_RATIO].value == pytest.approx(1.0)  # (600 - 200) / 400
    assert "Inventory" in r[RatioKey.QUICK_RATIO].note


def test_total_liabilities_derived_when_untagged():
    data = _company(
        Liabilities=None,
        LiabilitiesAndStockholdersEquity=[_inst(2200, "2023-12-31")],
        StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest=[_inst(1050, "2023-12-31")],
    )
    period, r = _ratios(data)
    liabilities = period.values[Metric.TOTAL_LIABILITIES]
    assert liabilities.value == 1150  # 2200 - equity incl. NCI
    assert liabilities.source_tag == DERIVED_LIABILITIES_TAG
    assert r[RatioKey.DEBT_TO_EQUITY].value == pytest.approx(1.15)


def test_negative_equity_debt_to_equity_not_meaningful():
    _, r = _ratios(_company(StockholdersEquity=[_inst(-50, "2023-12-31")]))
    assert r[RatioKey.DEBT_TO_EQUITY].value is None
    assert "negative" in r[RatioKey.DEBT_TO_EQUITY].note


def test_asset_turnover_without_opening_balance_uses_ending_assets():
    _, r = _ratios(_company(Assets=[_inst(2000, "2023-12-31")]))
    assert r[RatioKey.ASSET_TURNOVER].value == pytest.approx(0.5)
    assert "ending" in r[RatioKey.ASSET_TURNOVER].note


def test_missing_inputs_give_no_ratio():
    _, r = _ratios(_company(AssetsCurrent=None, LiabilitiesCurrent=None))
    assert r[RatioKey.CURRENT_RATIO] is None


def test_free_cash_flow_derived_from_operating_cash_flow_less_capex():
    period, _ = _ratios(
        _company(
            NetCashProvidedByUsedInOperatingActivities=[_dur(300, *FY23)],
            PaymentsToAcquirePropertyPlantAndEquipment=[_dur(80, *FY23)],
        )
    )
    assert period.values[Metric.FREE_CASH_FLOW].value == 220


def test_no_free_cash_flow_without_operating_cash_flow():
    period, _ = _ratios(_company(PaymentsToAcquirePropertyPlantAndEquipment=[_dur(80, *FY23)]))
    assert Metric.FREE_CASH_FLOW not in period.values


def test_goodwill_and_intangibles_combined_or_summed():
    from app.services.gaap_mapping import DERIVED_GOODWILL_TAG

    summed = _company(Goodwill=[_inst(300, "2023-12-31")], IntangibleAssetsNetExcludingGoodwill=[_inst(50, "2023-12-31")])
    (period,) = normalize_company_facts(summed, PeriodType.ANNUAL)
    item = period.values[Metric.GOODWILL_AND_INTANGIBLES]
    assert (item.value, item.source_tag) == (350, DERIVED_GOODWILL_TAG)

    goodwill_only = _company(Goodwill=[_inst(300, "2023-12-31")])
    (period,) = normalize_company_facts(goodwill_only, PeriodType.ANNUAL)
    assert period.values[Metric.GOODWILL_AND_INTANGIBLES].value == 300

    combined = _company(IntangibleAssetsNetIncludingGoodwill=[_inst(420, "2023-12-31")], Goodwill=[_inst(300, "2023-12-31")])
    (period,) = normalize_company_facts(combined, PeriodType.ANNUAL)
    assert period.values[Metric.GOODWILL_AND_INTANGIBLES].value == 420  # combined line wins, no double count

    # Coca-Cola style: goodwill + finite-lived + indefinite-lived trademarks, no all-in tag.
    ko = _company(
        Goodwill=[_inst(15, "2023-12-31")], FiniteLivedIntangibleAssetsNet=[_inst(1, "2023-12-31")], IndefiniteLivedTrademarks=[_inst(12, "2023-12-31")]
    )
    (period,) = normalize_company_facts(ko, PeriodType.ANNUAL)
    assert period.values[Metric.GOODWILL_AND_INTANGIBLES].value == 28
