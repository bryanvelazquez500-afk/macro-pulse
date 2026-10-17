import pytest

from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType
from app.services.variance import compare, compute_variances, find_prior_year_period, severity_tier


def _period(start, end, fy, fp="FY", period_type=PeriodType.ANNUAL, **values):
    return NormalizedPeriod(
        period_type=period_type,
        start=start,
        end=end,
        fiscal_year=fy,
        fiscal_period=fp,
        values={Metric(k): NormalizedValue(v, "Tag", "A", "10-K", "2024-01-01") for k, v in values.items()},
    )


@pytest.mark.parametrize(
    ("current", "prior", "pct", "flagged"),
    [
        (112, 100, 12.0, True),
        (88, 100, -12.0, True),
        (110, 100, 10.0, False),  # exactly 10% is not "more than" 10%
        (90, 100, -10.0, False),
        (105, 100, 5.0, False),
        (-120, -100, -20.0, True),  # loss deepened
        (50, -100, 150.0, True),  # swung from loss to profit
    ],
)
def test_compare(current, prior, pct, flagged):
    change, is_flagged = compare(current, prior, 0.10)
    assert change == pytest.approx(pct)
    assert is_flagged is flagged


def test_zero_prior_flags_any_movement():
    assert compare(5, 0, 0.10) == (None, True)
    assert compare(0, 0, 0.10) == (None, False)


def test_annual_variance_flags_only_material_items():
    periods = [
        _period("2023-01-01", "2023-12-31", 2023, revenue=1150, net_income=104),
        _period("2022-01-01", "2022-12-31", 2022, revenue=1000, net_income=100),
    ]
    v = compute_variances(periods)[("2023-01-01", "2023-12-31")]
    assert v[Metric.REVENUE].flagged and v[Metric.REVENUE].change_pct == pytest.approx(15.0)
    assert not v[Metric.NET_INCOME].flagged
    assert v[Metric.REVENUE].prior_fiscal_year == 2022
    # The oldest period has no prior year to compare against.
    assert ("2022-01-01", "2022-12-31") not in compute_variances(periods)


def test_quarterly_compares_same_quarter_prior_year_not_sequential():
    q = PeriodType.QUARTERLY
    q3_2024 = _period("2024-06-30", "2024-09-28", 2024, "Q3", q, revenue=100)
    q2_2024 = _period("2024-03-31", "2024-06-29", 2024, "Q2", q, revenue=200)
    q3_2023 = _period("2023-07-02", "2023-09-30", 2023, "Q3", q, revenue=80)
    assert find_prior_year_period(q3_2024, [q3_2024, q2_2024, q3_2023]) is q3_2023
    v = compute_variances([q3_2024, q2_2024, q3_2023])[q3_2024.key]
    assert v[Metric.REVENUE].change_pct == pytest.approx(25.0)


def test_53_week_year_still_matches_prior_year():
    current = _period("2023-01-01", "2023-12-30", 2023, revenue=100)  # 52-week year
    prior = _period("2021-12-26", "2022-12-31", 2022, revenue=100)  # 53-week year
    assert find_prior_year_period(current, [current, prior]) is prior


def test_variance_threshold_is_configurable():
    periods = [
        _period("2023-01-01", "2023-12-31", 2023, revenue=1060),
        _period("2022-01-01", "2022-12-31", 2022, revenue=1000),
    ]
    assert compute_variances(periods, 0.05)[periods[0].key][Metric.REVENUE].flagged
    assert not compute_variances(periods, 0.10)[periods[0].key][Metric.REVENUE].flagged


@pytest.mark.parametrize(
    ("change_pct", "tier"),
    [
        (10.5, 1),
        (19.9, 1),
        (19.9999999, 2),  # float noise rounds up to the boundary
        (20.0, 2),
        (-29.9, 2),
        (30.0, 3),
        (-39.9, 3),
        (40.0, 4),
        (-87.0, 4),
        (None, 4),  # moved off a zero base
    ],
)
def test_severity_tiers(change_pct, tier):
    assert severity_tier(change_pct, flagged=True) == tier


def test_unflagged_items_have_no_tier():
    assert severity_tier(8.0, flagged=False) is None


def test_variance_carries_direction_and_tier():
    periods = [
        _period("2023-01-01", "2023-12-31", 2023, revenue=1250, net_income=50),
        _period("2022-01-01", "2022-12-31", 2022, revenue=1000, net_income=100),
    ]
    v = compute_variances(periods)[periods[0].key]
    assert (v[Metric.REVENUE].direction, v[Metric.REVENUE].severity_tier) == ("up", 2)
    assert (v[Metric.NET_INCOME].direction, v[Metric.NET_INCOME].severity_tier) == ("down", 4)
