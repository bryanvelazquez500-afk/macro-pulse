"""TTM and share-history logic behind the DCF calculator (synthetic facts only)."""

from datetime import date

import pytest

from app.services.dcf_inputs import annual_shares, historical_growth, ttm_value
from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType
from app.services.market_caps import recent_quarters
from app.services.sec_client import merge_company_facts


def fact(start, end, val, form="10-Q", filed="2026-01-01"):
    return {"start": start, "end": end, "val": val, "form": form, "filed": filed, "accn": f"a-{end}-{form}"}


def facts_doc(tag_facts):
    return {"facts": {"us-gaap": {tag: {"units": {"USD": fs}} for tag, fs in tag_facts.items()}}}


def test_ttm_is_last_year_plus_ytd_minus_prior_ytd():
    doc = facts_doc({
        "NetIncomeLoss": [
            fact("2025-01-01", "2025-12-31", 100.0, "10-K", "2026-02-01"),
            fact("2026-01-01", "2026-06-30", 60.0, "10-Q", "2026-08-01"),  # current 6-month YTD
            fact("2025-01-01", "2025-06-30", 40.0, "10-Q", "2026-08-01"),  # prior-year comparative
        ]
    })  # fmt: skip
    assert ttm_value(doc, ["NetIncomeLoss"], "USD") == (120.0, "2026-06-30", True)


def test_ttm_falls_back_to_latest_fiscal_year_without_quarterlies():
    doc = facts_doc({"NetIncomeLoss": [fact("2024-01-01", "2024-12-31", 80.0, "20-F"), fact("2025-01-01", "2025-12-31", 90.0, "20-F")]})
    assert ttm_value(doc, ["NetIncomeLoss"], "USD") == (90.0, "2025-12-31", False)


def period(year, ni, shares):
    values = {Metric.NET_INCOME: NormalizedValue(ni, "t", None, "10-K", "x")}
    if shares is not None:
        values[Metric.DILUTED_SHARES] = NormalizedValue(shares, "t", None, "10-K", "x")
    return NormalizedPeriod(PeriodType.ANNUAL, f"{year}-01-01", f"{year}-12-31", year, "FY", values)


def test_unrestated_split_is_detected_from_a_share_count_jump():
    # 5-for-1 split between 2020 and 2021 that no filing restated; EPS grows 10%/yr on today's basis.
    annual = [period(y, 1.1 ** (y - 2015) * 500, 100 if y <= 2020 else 500) for y in range(2025, 2014, -1)]
    shares = annual_shares(annual, None, "USD")
    assert shares[id(annual[-1])] == pytest.approx(500)  # 2015 restated to the post-split count
    h10, years, _ = historical_growth(annual, "eps", shares)
    assert years == 10 and h10 == pytest.approx(10.0)


def test_missing_share_counts_are_implied_from_reported_eps():
    annual = [period(2025, 200.0, None)]
    doc = {"facts": {"us-gaap": {"EarningsPerShareDiluted": {"units": {"USD/shares": [fact("2025-01-01", "2025-12-31", 2.0, "10-K")]}}}}}
    assert annual_shares(annual, doc, "USD")[id(annual[0])] == pytest.approx(100.0)


def test_recent_quarters():
    assert recent_quarters(date(2026, 10, 17), 3) == [(2026, 3), (2026, 2), (2026, 1)]
    assert recent_quarters(date(2026, 2, 1), 2) == [(2025, 4), (2025, 3)]


def test_merge_company_facts_keeps_both_histories():
    old = facts_doc({"NetIncomeLoss": [fact("2024-01-01", "2024-12-31", 1.0, "10-K")]})
    new = facts_doc({"NetIncomeLoss": [fact("2025-01-01", "2025-12-31", 2.0, "10-K")]})
    merged = merge_company_facts(old, new)
    assert [f["val"] for f in merged["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"]] == [1.0, 2.0]
