import pytest

from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType
from app.services.gurufocus import fair_value, historical_eps_growth

# Shared test vector — frontend/src/lib/gurufocusDcf.ts must produce the same number for these inputs
# (EPS 2, growth 10%, discount 11%, tangible book 5 → 37.0283…), so the two implementations can't drift.
VECTOR = {"eps": 2.0, "growth": 0.10, "discount": 0.11, "tbv": 5.0, "fair_value": 37.02828768}


def test_shared_vector():
    value, growth_stage, terminal_stage = fair_value(VECTOR["eps"], VECTOR["growth"], VECTOR["discount"], VECTOR["tbv"])
    assert value == pytest.approx(VECTOR["fair_value"], abs=1e-6)
    assert growth_stage + terminal_stage + VECTOR["tbv"] == pytest.approx(value)


def test_growth_equal_to_discount_is_a_plain_sum():
    value, growth_stage, _ = fair_value(1.0, 0.11, 0.11, 0.0)
    assert growth_stage == pytest.approx(10.0)


def _year(fy, ni, shares=100):
    nv = lambda v: NormalizedValue(v, "t", "a", "10-K", "2025-01-01")  # noqa: E731
    return NormalizedPeriod(PeriodType.ANNUAL, f"{fy}-01-01", f"{fy}-12-31", fy, "FY", {Metric.NET_INCOME: nv(ni), Metric.DILUTED_SHARES: nv(shares)})


def test_historical_growth_prefers_ten_years_then_falls_back():
    ten = [_year(2025 - i, 200 / 1.1**i) for i in range(11)]
    assert historical_eps_growth(ten) == (pytest.approx(0.10), 10)
    # Loss ten years ago (and five): falls back to three years.
    patchy = [_year(2025, 200), _year(2024, 180), _year(2023, 170), _year(2022, 150), _year(2020, -5), _year(2015, -10)]
    rate, years = historical_eps_growth(patchy)
    assert years == 3 and rate == pytest.approx((200 / 150) ** (1 / 3) - 1)
    assert historical_eps_growth([_year(2025, -1), _year(2015, 5)]) is None
