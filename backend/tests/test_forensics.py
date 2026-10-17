import pytest

from app.services.forensics import altman_z, compute_forensics, piotroski, sloan_accruals
from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType


def _nv(v):
    return NormalizedValue(v, "Tag", "A", "10-K", "2024-01-01")


def _period(fy, opening_assets=None, period_type=PeriodType.ANNUAL, **values):
    return NormalizedPeriod(
        period_type=period_type,
        start=f"{fy}-01-01",
        end=f"{fy}-12-31",
        fiscal_year=fy,
        fiscal_period="FY",
        values={Metric(k): _nv(v) for k, v in values.items()},
        opening_balances={Metric.TOTAL_ASSETS: _nv(opening_assets)} if opening_assets else {},
    )


STRONG = dict(
    revenue=1200, cost_of_goods_sold=600, net_income=120, operating_cash_flow=150, operating_income=180,
    total_assets=1000, current_assets=500, current_liabilities=250, long_term_debt=150, diluted_shares=100,
    retained_earnings=400, stockholders_equity=500, total_liabilities=500,
)  # fmt: skip
PRIOR = dict(
    revenue=1000, cost_of_goods_sold=550, net_income=80, operating_cash_flow=90, operating_income=130,
    total_assets=950, current_assets=420, current_liabilities=250, long_term_debt=200, diluted_shares=100,
    retained_earnings=300, stockholders_equity=450, total_liabilities=500,
)  # fmt: skip


def test_piotroski_all_nine_signals_pass():
    current = _period(2024, opening_assets=950, **STRONG)
    prior = _period(2023, opening_assets=900, **PRIOR)
    result = piotroski(current, prior)
    assert result.available == 9
    assert result.score == 9
    assert all(s.passed for s in result.signals)


def test_piotroski_detects_dilution_and_cash_shortfall():
    current = _period(2024, opening_assets=950, **{**STRONG, "diluted_shares": 110, "operating_cash_flow": 100})
    prior = _period(2023, opening_assets=900, **PRIOR)
    failed = {s.key for s in piotroski(current, prior).signals if s.passed is False}
    assert failed == {"no_dilution", "cash_over_earnings"}


def test_piotroski_withholds_score_when_data_is_thin():
    current = _period(2024, opening_assets=950, **STRONG)
    result = piotroski(current, None)  # no prior year: 6 of 9 signals need it
    assert result.available == 3
    assert result.score is None


def test_altman_z_book_equity_variant():
    z = altman_z(_period(2024, **STRONG))
    expected = 6.56 * 250 / 1000 + 3.26 * 400 / 1000 + 6.72 * 180 / 1000 + 1.05 * 500 / 500
    assert z.value == pytest.approx(expected)
    assert z.zone == "safe"


def test_altman_z_distress_zone():
    weak = {**STRONG, "current_assets": 200, "current_liabilities": 400, "retained_earnings": -300, "operating_income": -20,
            "stockholders_equity": 100, "total_liabilities": 900}  # fmt: skip
    assert altman_z(_period(2024, **weak)).zone == "distress"


def test_altman_z_needs_classified_balance_sheet():
    bank = {k: v for k, v in STRONG.items() if k not in ("current_assets", "current_liabilities")}
    z = altman_z(_period(2024, **bank))
    assert z.value is None and "classified" in z.note


def test_sloan_accruals_flags_earnings_ahead_of_cash():
    period = _period(2024, opening_assets=1000, **{**STRONG, "net_income": 250, "operating_cash_flow": 100})
    result = sloan_accruals(period)
    assert result.value == pytest.approx(15.0)  # (250 − 100) / avg(1000, 1000)
    assert result.zone == "high"


def test_quarterly_periods_get_no_scores():
    result = compute_forensics(_period(2024, period_type=PeriodType.QUARTERLY, **STRONG), None)
    assert result.piotroski is None and "annual" in result.note
