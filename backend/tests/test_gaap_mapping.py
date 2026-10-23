import pytest
from app.services.gaap_mapping import Metric, PeriodType, normalize_company_facts


def _fact(val, start, end, form="10-K", filed="2020-02-01", fy=2019, fp="FY", accn="0000000000-20-000001"):
    return {"val": val, "start": start, "end": end, "form": form, "filed": filed, "fy": fy, "fp": fp, "accn": accn}


def _facts(**tags):
    return {"facts": {"us-gaap": {tag: {"units": {"USD": facts}} for tag, facts in tags.items()}}}


def test_merges_revenue_across_tag_change():
    # Pre-ASC 606 filings used SalesRevenueNet; later ones use RevenueFromContract...
    data = _facts(
        SalesRevenueNet=[_fact(100, "2017-01-01", "2017-12-31", fy=2017, filed="2018-02-01", accn="A-17")],
        RevenueFromContractWithCustomerExcludingAssessedTax=[
            _fact(120, "2018-01-01", "2018-12-31", fy=2018, filed="2019-02-01", accn="A-18")
        ],
    )
    periods = normalize_company_facts(data, PeriodType.ANNUAL)
    assert [(p.fiscal_year, p.values[Metric.REVENUE].value) for p in periods] == [(2018, 120), (2017, 100)]
    assert periods[0].values[Metric.REVENUE].source_tag == "RevenueFromContractWithCustomerExcludingAssessedTax"
    assert periods[1].values[Metric.REVENUE].source_tag == "SalesRevenueNet"


def test_higher_priority_tag_wins_for_same_period():
    data = _facts(
        Revenues=[_fact(500, "2022-01-01", "2022-12-31")],
        SalesRevenueNet=[_fact(450, "2022-01-01", "2022-12-31")],
    )
    (period,) = normalize_company_facts(data)
    assert period.values[Metric.REVENUE].value == 500
    assert period.values[Metric.REVENUE].source_tag == "Revenues"


def test_maps_all_four_metrics():
    span = ("2023-01-01", "2023-12-31")
    data = _facts(
        Revenues=[_fact(1000, *span)],
        CostOfGoodsAndServicesSold=[_fact(600, *span)],
        OperatingIncomeLoss=[_fact(250, *span)],
        ProfitLoss=[_fact(180, *span)],
    )
    (period,) = normalize_company_facts(data)
    assert {m: v.value for m, v in period.values.items()} == {
        Metric.REVENUE: 1000,
        Metric.COST_OF_GOODS_SOLD: 600,
        Metric.OPERATING_INCOME: 250,
        Metric.NET_INCOME: 180,
    }


def test_restatement_uses_latest_value_but_original_fiscal_year():
    data = _facts(
        NetIncomeLoss=[
            _fact(90, "2021-01-01", "2021-12-31", fy=2021, filed="2022-02-01", accn="A-21"),
            _fact(85, "2021-01-01", "2021-12-31", fy=2023, filed="2024-02-01", accn="A-23"),  # restated comparative
        ]
    )
    (period,) = normalize_company_facts(data)
    assert period.values[Metric.NET_INCOME].value == 85
    assert period.fiscal_year == 2021


def test_quarterly_excludes_year_to_date_and_annual():
    data = _facts(
        Revenues=[
            _fact(30, "2023-04-01", "2023-06-30", form="10-Q", fp="Q2"),  # discrete quarter
            _fact(55, "2023-01-01", "2023-06-30", form="10-Q", fp="Q2"),  # six months YTD
            _fact(120, "2023-01-01", "2023-12-31", form="10-K"),
        ]
    )
    quarterly = normalize_company_facts(data, PeriodType.QUARTERLY)
    assert [p.values[Metric.REVENUE].value for p in quarterly] == [30]
    annual = normalize_company_facts(data, PeriodType.ANNUAL)
    assert [p.values[Metric.REVENUE].value for p in annual] == [120]


def test_uses_the_reporting_currency_and_ignores_other_units():
    # A US GAAP filer reporting in EUR (like ASML): EUR facts are used, stray USD ones are not.
    span = ("2023-01-01", "2023-12-31")
    data = {
        "facts": {
            "us-gaap": {
                "Revenues": {"units": {"EUR": [_fact(100, *span)]}},
                "NetIncomeLoss": {"units": {"EUR": [_fact(20, *span)], "USD": [_fact(22, *span)]}},
            }
        }
    }
    (period,) = normalize_company_facts(data)
    assert period.values[Metric.REVENUE].value == 100
    assert period.values[Metric.NET_INCOME].value == 20


def test_ignores_missing_tags():
    assert normalize_company_facts({"facts": {"us-gaap": {}}}) == []


def test_comparative_only_periods_get_their_own_fiscal_year():
    # Both prior years first appear under this tag as comparatives in the FY2018 10-K.
    accn = "0000320193-18-000145"
    data = _facts(
        Revenues=[
            _fact(265, "2017-10-01", "2018-09-29", fy=2018, filed="2018-11-05", accn=accn),
            _fact(229, "2016-09-25", "2017-09-30", fy=2018, filed="2018-11-05", accn=accn),
            _fact(215, "2015-09-27", "2016-09-24", fy=2018, filed="2018-11-05", accn=accn),
        ]
    )
    assert [p.fiscal_year for p in normalize_company_facts(data)] == [2018, 2017, 2016]


def test_free_cash_flow_needs_reported_capex():
    span = ("2025-01-01", "2025-12-31")
    no_capex = _facts(NetCashProvidedByUsedInOperatingActivities=[_fact(37, *span)])
    (period,) = normalize_company_facts(no_capex)
    assert Metric.FREE_CASH_FLOW not in period.values  # unknown capex is not zero capex

    verizon_style = _facts(
        NetCashProvidedByUsedInOperatingActivities=[_fact(37, *span)],
        PaymentsToAcquireOtherProductiveAssets=[_fact(17, *span)],
    )
    (period,) = normalize_company_facts(verizon_style)
    assert period.values[Metric.FREE_CASH_FLOW].value == 20


def test_quarterly_cash_flows_are_derived_from_year_to_date_figures():
    from app.services.gaap_mapping import Metric, PeriodType, normalize_company_facts

    def f(tag_val, start, end, form="10-Q", filed="2025-08-01"):
        return {"val": tag_val, "start": start, "end": end, "form": form, "filed": filed, "fy": 2025, "fp": "Q2", "accn": f"a-{end}"}

    data = {"facts": {"us-gaap": {
        "Revenues": {"units": {"USD": [f(100, "2025-01-01", "2025-03-31", filed="2025-05-01"), f(120, "2025-04-01", "2025-06-30")]}},
        "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [
            f(30, "2025-01-01", "2025-03-31", filed="2025-05-01"),  # Q1 (three months)
            f(75, "2025-01-01", "2025-06-30"),  # six-month year-to-date
        ]}},
    }}}  # fmt: skip
    q2, q1 = normalize_company_facts(data, PeriodType.QUARTERLY)
    assert q1.values[Metric.OPERATING_CASH_FLOW].value == 30
    assert q2.values[Metric.OPERATING_CASH_FLOW].value == 45  # 75 − 30
    assert "year-to-date" in q2.values[Metric.OPERATING_CASH_FLOW].source_tag


def test_share_counts_tagged_in_millions_are_rescaled_not_treated_as_splits():
    """McDonald's 10-Ks from 2024 tag 741.3 for 741,300,000 diluted shares (restating earlier years the same way)."""
    from app.services.gaap_mapping import Metric, PeriodType, detect_share_splits, normalize_company_facts

    def fact(val, start, end, filed, form="10-K"):
        return {"val": val, "start": start, "end": end, "form": form, "filed": filed, "fy": int(end[:4]), "fp": "FY", "accn": f"a-{filed}"}

    shares = [
        fact(741_300_000, "2022-01-01", "2022-12-31", "2023-02-20"),
        fact(741.3, "2022-01-01", "2022-12-31", "2024-02-20"),  # same year, restated "in millions"
        fact(732.3, "2023-01-01", "2023-12-31", "2024-02-20"),
    ]
    data = {"facts": {"us-gaap": {
        "WeightedAverageNumberOfDilutedSharesOutstanding": {"units": {"shares": shares}},
        "NetIncomeLoss": {"units": {"USD": [fact(6.18e9, "2022-01-01", "2022-12-31", "2024-02-20"), fact(8.47e9, "2023-01-01", "2023-12-31", "2024-02-20")]}},
        "EarningsPerShareDiluted": {"units": {"USD/shares": [fact(8.33, "2022-01-01", "2022-12-31", "2024-02-20"), fact(11.56, "2023-01-01", "2023-12-31", "2024-02-20")]}},
    }}}  # fmt: skip
    assert detect_share_splits(data, ["WeightedAverageNumberOfDilutedSharesOutstanding"]) == []  # ×1e-6 is not a split
    fy23, fy22 = normalize_company_facts(data, PeriodType.ANNUAL)
    assert fy23.values[Metric.DILUTED_SHARES].value == pytest.approx(732_300_000)
    assert fy22.values[Metric.DILUTED_SHARES].value == pytest.approx(741_300_000)
    assert "corrected" in fy23.values[Metric.DILUTED_SHARES].source_tag


def test_market_split_records_cover_splits_after_the_latest_filing():
    """HDFC Bank's 1:1 bonus issue (Aug 2025) came after its FY2025 20-F: only the split record shows it."""
    from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType, apply_market_splits

    def period(shares, filed, tag="WeightedAverageNumberOfDilutedSharesOutstanding"):
        return NormalizedPeriod(PeriodType.ANNUAL, "2024-04-01", "2025-03-31", 2025, "FY",
                                {Metric.DILUTED_SHARES: NormalizedValue(shares, tag, "a", "20-F", filed)})  # fmt: skip

    fy25 = period(7.66e9, "2025-07-14")
    restated = period(15.3e9, "2025-07-14", "WeightedAverageNumberOfDilutedSharesOutstanding (split-adjusted ×2)")
    later = period(15.3e9, "2026-07-14")
    apply_market_splits([fy25, restated, later], [("2019-09-19", 2.0), ("2025-08-26", 2.0)])
    assert fy25.values[Metric.DILUTED_SHARES].value == pytest.approx(15.32e9)  # filed before the bonus issue
    assert restated.values[Metric.DILUTED_SHARES].value == pytest.approx(15.3e9)  # already restated: untouched
    assert later.values[Metric.DILUTED_SHARES].value == pytest.approx(15.3e9)  # filed after: already on the new basis


def test_eps_numerator_is_net_income_available_to_common():
    from app.services.gaap_mapping import Metric, PeriodType, normalize_company_facts

    def fact(val, unit_end="2025-12-31"):
        return {"val": val, "start": "2025-01-01", "end": unit_end, "form": "10-K", "filed": "2026-02-20", "fy": 2025, "fp": "FY", "accn": "a"}

    data = {"facts": {"us-gaap": {
        "NetIncomeLoss": {"units": {"USD": [fact(16.0e9)]}},
        "NetIncomeLossAvailableToCommonStockholdersDiluted": {"units": {"USD": [fact(15.2e9)]}},  # after preferred dividends
        "WeightedAverageNumberOfDilutedSharesOutstanding": {"units": {"shares": [fact(300e6)]}},
        "EarningsPerShareDiluted": {"units": {"USD/shares": [fact(50.67)]}},
    }}}  # fmt: skip
    (fy,) = normalize_company_facts(data, PeriodType.ANNUAL)
    eps = fy.values[Metric.NET_INCOME_COMMON].value / fy.values[Metric.DILUTED_SHARES].value
    assert eps == pytest.approx(50.67, abs=0.01)  # matches the reported GAAP EPS, not 16.0e9 / 300e6 = 53.33


def test_fiscal_fourth_quarter_is_the_year_less_the_first_three_quarters():
    q = lambda val, start, end, fp: _fact(val, start, end, form="10-Q", fy=2025, fp=fp, accn=f"Q-{fp}")  # noqa: E731
    data = _facts(
        Revenues=[
            q(100, "2024-10-01", "2024-12-31", "Q1"),
            q(110, "2025-01-01", "2025-03-31", "Q2"),
            q(120, "2025-04-01", "2025-06-30", "Q3"),
            _fact(470, "2024-10-01", "2025-09-30", fy=2025, accn="K-25", filed="2025-11-01"),
        ],
    )
    data["facts"]["us-gaap"]["WeightedAverageNumberOfDilutedSharesOutstanding"] = {
        "units": {"shares": [q(10, "2025-04-01", "2025-06-30", "Q3"), _fact(10, "2024-10-01", "2025-09-30")]}
    }
    q4, *_ = normalize_company_facts(data, PeriodType.QUARTERLY)

    assert (q4.fiscal_year, q4.fiscal_period, q4.start, q4.end) == (2025, "Q4", "2025-07-01", "2025-09-30")
    assert q4.values[Metric.REVENUE].value == 140
    assert q4.values[Metric.REVENUE].source_tag == "Revenues (full year − first three quarters)"
    assert Metric.DILUTED_SHARES not in q4.values  # a weighted average can't be subtracted


def test_no_fourth_quarter_without_all_three_quarters():
    data = _facts(Revenues=[
        _fact(110, "2025-01-01", "2025-03-31", form="10-Q", fp="Q2", accn="Q-2"),
        _fact(120, "2025-04-01", "2025-06-30", form="10-Q", fp="Q3", accn="Q-3"),
        _fact(470, "2024-10-01", "2025-09-30"),
    ])
    assert [p.end for p in normalize_company_facts(data, PeriodType.QUARTERLY)] == ["2025-06-30", "2025-03-31"]
