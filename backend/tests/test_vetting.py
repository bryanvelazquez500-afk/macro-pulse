"""Legend checklist rules, split adjustment and quote sourcing."""

import httpx
import pytest

from app.core.config import Settings
from app.services.checklist_service import price_context
from app.services.fmp_client import FmpClient
from app.services.gaap_mapping import Metric, NormalizedPeriod, NormalizedValue, PeriodType, detect_share_splits, normalize_company_facts
from app.services.quotes import Quote, QuoteService, normalize_price, yahoo_symbol
from app.services.vetting import PriceContext, Verdict, evaluate, gross_margin_stability, leverage, operating_leverage, peg_ratio, roic


def _nv(value, form="10-K"):
    return NormalizedValue(value=value, source_tag="t", accession_number="a", form=form, filed="2025-01-01")


def _period(fy, opening=None, **metrics):
    values = {Metric(k): _nv(v) for k, v in metrics.items() if v is not None}
    return NormalizedPeriod(
        PeriodType.ANNUAL, f"{fy}-01-01", f"{fy}-12-31", fy, "FY", values,
        {Metric(k): _nv(v) for k, v in (opening or {}).items()},
    )  # fmt: skip


def _compounder(years=5, growth=0.10, margin=0.40, op_margin_step=0.01, ni_growth=0.25, share_shrink=0.0):
    """A steadily growing, cash-generative, lightly levered business, newest first."""
    periods = []
    for i in range(years):
        fy = 2025 - i
        revenue = 1_000 * (1 + growth) ** -i
        op_income = revenue * (0.25 - op_margin_step * i)
        net_income = 150 * (1 + ni_growth) ** -i
        periods.append(
            _period(
                fy,
                opening={"stockholders_equity": 900, "long_term_debt": 100},
                revenue=revenue, cost_of_goods_sold=revenue * (1 - margin), operating_income=op_income,
                net_income=net_income, pretax_income=op_income, income_tax_expense=op_income * 0.2,
                diluted_shares=100 * (1 + share_shrink) ** i, inventory=revenue * 0.1, sga_expense=revenue * 0.15,
                operating_cash_flow=net_income * 1.2, capital_expenditures=net_income * 0.2, free_cash_flow=net_income,
                cash_and_equivalents=300, current_assets=800, current_liabilities=400, total_assets=2_000,
                total_liabilities=1_000, stockholders_equity=1_000, retained_earnings=600, long_term_debt=100,
            )
        )  # fmt: skip
    return periods


def _price(price, currency="USD"):
    return PriceContext(Quote("X", price, currency, "test", None), comparable=True)


def test_roic_uses_effective_tax_and_average_invested_capital():
    p = _compounder()[0]
    c = roic(p)
    # NOPAT 250 × 0.8 = 200; invested capital avg((1000+100), (900+100)) = 1050
    assert c.value == pytest.approx(200 / 1050 * 100) and c.passed


def test_roic_not_meaningful_with_equity_deficit():
    p = _period(2025, operating_income=100, stockholders_equity=-500, long_term_debt=200)
    c = roic(p)
    assert c.passed is None and "not meaningful" in c.note


def test_roic_falls_back_to_statutory_tax_on_a_pretax_loss():
    p = _period(2025, operating_income=100, pretax_income=-10, income_tax_expense=5, stockholders_equity=500)
    assert roic(p).value == pytest.approx(100 * 0.79 / 500 * 100) and "statutory" in roic(p).display


def test_gross_margin_stability():
    assert gross_margin_stability(_compounder()).passed
    volatile = _compounder()
    volatile[2].values[Metric.COST_OF_GOODS_SOLD] = _nv(volatile[2].values[Metric.REVENUE].value * 0.7)  # 30% margin
    c = gross_margin_stability(volatile)
    assert not c.passed and c.value == pytest.approx(10.0)


def test_peg_from_price_eps_and_eps_growth():
    history = _compounder()  # EPS 1.50 now, growing 25%/yr
    c = peg_ratio(history, _price(30.0), "USD")  # P/E 20 ÷ 25 = 0.8
    assert c.value == pytest.approx(20 / 25, rel=0.01) and c.passed
    assert not peg_ratio(history, _price(60.0), "USD").passed  # P/E 40 → PEG 1.6


def test_peg_refuses_incomparable_prices_and_shrinking_eps():
    history = _compounder()
    adr = PriceContext(Quote("X", 30, "USD", "test", None), comparable=False, note="ADR")
    assert peg_ratio(history, adr, "EUR").passed is None
    shrinking = _compounder(ni_growth=-0.10)
    c = peg_ratio(shrinking, _price(30.0), "USD")
    assert c.passed is False and "grown" in c.note


def test_leverage_rules():
    assert leverage(_period(2025, stockholders_equity=1_000, long_term_debt=200)).passed
    assert not leverage(_period(2025, stockholders_equity=1_000, long_term_debt=800)).passed
    assert leverage(_period(2025, stockholders_equity=-10, long_term_debt=10)).passed is False
    # No debt tag: debt-free only if liabilities are small too (banks fund themselves with deposits).
    assert leverage(_period(2025, stockholders_equity=1_000, total_liabilities=300)).passed
    assert leverage(_period(2025, stockholders_equity=1_000, total_liabilities=9_000)).passed is None


def test_operating_leverage():
    c = operating_leverage(_compounder())  # margins expanding on 10% growth
    assert c.passed and c.value > 1.25
    flat_margin = operating_leverage(_compounder(op_margin_step=0))
    assert flat_margin.value == pytest.approx(1.0, abs=0.01) and not flat_margin.passed
    shrinking = operating_leverage(_compounder(growth=-0.05))
    assert shrinking.passed is False and "reverse" in shrinking.note


def test_verdicts():
    # Shrinking share count and a 45% gross margin: every rule passes (buybacks also lift Piotroski to 7).
    by_name = {c.key: c for c in evaluate(_compounder(margin=0.45, share_shrink=0.02), _price(30.0), "USD")}
    assert {k: [c.key for c in v.criteria if not c.passed] for k, v in by_name.items()} == {
        "buffett": [], "lynch": [], "munger": [], "ackman": [],
    }  # fmt: skip
    assert all(v.verdict is Verdict.WORTH_BUYING and v.summary == f"Meets all {len(v.criteria)} criteria" for v in by_name.values())
    # A constant share count isn't dilution (Piotroski still passes), but Buffett wants it falling.
    flat = {c.key: c for c in evaluate(_compounder(margin=0.45), _price(30.0), "USD")}
    assert flat["buffett"].verdict is Verdict.PASS and flat["buffett"].summary == "Fails: Declining share count"
    assert flat["munger"].verdict is Verdict.WORTH_BUYING
    # Missing data is never a buy.
    no_price = {c.key: c for c in evaluate(_compounder(), PriceContext(None, False, "no price"), "USD")}
    assert no_price["lynch"].verdict is Verdict.PASS and no_price["lynch"].summary.startswith("Can't confirm")
    assert evaluate([], _price(1), "USD") == []


def test_price_context():
    q = Quote("X", 10, "USD", "test", None)
    assert price_context(q, "USD", priced_us_listing=True, foreign_filer=False).comparable
    assert not price_context(q, "USD", priced_us_listing=True, foreign_filer=True).comparable  # ADR ratio unknown
    assert not price_context(q, "EUR", priced_us_listing=False, foreign_filer=True).comparable
    assert not price_context(None, "USD", priced_us_listing=True, foreign_filer=False).comparable


# ---------------------------------------------------------------- splits


def _shares(val, start, end, filed, fy):
    return {"val": val, "start": start, "end": end, "form": "10-K", "filed": filed, "fy": fy, "fp": "FY", "accn": f"A-{filed}"}


def test_detects_splits_from_restated_share_counts_and_adjusts_old_periods():
    # 10-for-1 split in mid-2024: FY2023 appears pre-split in the FY2023 10-K and post-split in the FY2024 10-K.
    tag = "WeightedAverageNumberOfDilutedSharesOutstanding"
    shares = [
        _shares(2_500, "2022-01-01", "2022-12-31", "2023-02-20", 2022),
        _shares(2_480, "2023-01-01", "2023-12-31", "2024-02-20", 2023),
        _shares(24_800, "2023-01-01", "2023-12-31", "2025-02-20", 2024),
        _shares(24_600, "2024-01-01", "2024-12-31", "2025-02-20", 2024),
    ]
    revenue = [_shares(v, f"{y}-01-01", f"{y}-12-31", f, y) for v, y, f in [(1, 2022, "2023-02-20"), (2, 2023, "2025-02-20"), (3, 2024, "2025-02-20")]]
    data = {"facts": {"us-gaap": {tag: {"units": {"shares": shares}}, "Revenues": {"units": {"USD": revenue}}}}}

    assert detect_share_splits(data, [tag]) == [("2025-02-20", pytest.approx(10.0))]
    fy24, fy23, fy22 = normalize_company_facts(data)
    assert [p.values[Metric.DILUTED_SHARES].value for p in (fy24, fy23, fy22)] == [24_600, 24_800, 25_000]
    assert "split-adjusted" in fy22.values[Metric.DILUTED_SHARES].source_tag


def test_ordinary_share_count_changes_are_not_splits():
    tag = "WeightedAverageNumberOfDilutedSharesOutstanding"
    shares = [_shares(1_000, "2023-01-01", "2023-12-31", "2024-02-01", 2023), _shares(1_012, "2023-01-01", "2023-12-31", "2025-02-01", 2024)]
    assert detect_share_splits({"facts": {"us-gaap": {tag: {"units": {"shares": shares}}}}}, [tag]) == []


# ---------------------------------------------------------------- quotes


def test_price_normalization_and_symbols():
    assert normalize_price(120.2, "GBp") == (pytest.approx(1.202), "GBP")
    assert normalize_price(1464.2, "EUR") == (1464.2, "EUR")
    assert yahoo_symbol("BRK.B") == "BRK-B" and yahoo_symbol("VOD.L") == "VOD.L"


async def test_quote_falls_back_to_yahoo_without_an_fmp_key():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        return httpx.Response(200, json={"chart": {"result": [{"meta": {"regularMarketPrice": 3908.0, "currency": "GBp", "regularMarketTime": 1760000000}}]}})

    settings = Settings(_env_file=None)
    fmp = FmpClient(settings, transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    quotes = QuoteService(fmp, settings, transport=httpx.MockTransport(handler))
    q = await quotes.get_quote("shel.l")
    await quotes.aclose()
    await fmp.aclose()
    assert (q.price, q.currency, q.source) == (pytest.approx(39.08), "GBP", "Yahoo Finance")
    assert seen == ["query1.finance.yahoo.com"]


async def test_quote_prefers_fmp_when_configured():
    settings = Settings(_env_file=None, FMP_API_KEY="k")
    fmp = FmpClient(settings, transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[{"price": 342.0, "currency": "USD"}])))
    quotes = QuoteService(fmp, settings, transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    q = await quotes.get_quote("AAPL")
    await quotes.aclose()
    await fmp.aclose()
    assert (q.price, q.source) == (342.0, "Financial Modeling Prep")


async def test_quote_failure_is_none_not_an_error():
    settings = Settings(_env_file=None)
    fmp = FmpClient(settings)
    quotes = QuoteService(fmp, settings, transport=httpx.MockTransport(lambda r: httpx.Response(429, text="Too Many Requests")))
    assert await quotes.get_quote("AAPL") is None
    await quotes.aclose()
    await fmp.aclose()


# ---------------------------------------------------------------- expanded criteria

from app.services.legend_context import LEGEND_CONTEXT  # noqa: E402
from app.services.vetting import (  # noqa: E402
    capex_intensity,
    fcf_yield,
    gross_margin_level,
    inventory_vs_sales,
    margin_expansion,
    net_cash,
    sga_stability,
    share_count_trend,
)


def test_capex_intensity_is_summed_across_years():
    history = _compounder()  # capex is 1/6 of OCF every year
    assert capex_intensity(history).value == pytest.approx(100 / 6) and capex_intensity(history).passed
    heavy = _compounder()
    heavy[0].values[Metric.CAPITAL_EXPENDITURES] = _nv(10_000)
    assert not capex_intensity(heavy).passed


def test_share_count_and_margin_trends():
    assert share_count_trend(_compounder(share_shrink=0.02)).passed
    growing = share_count_trend(_compounder(share_shrink=-0.02))
    assert not growing.passed and growing.value > 0
    assert margin_expansion(_compounder()).passed  # operating margin 21% → 25%
    assert not margin_expansion(_compounder(op_margin_step=-0.01)).passed


def test_inventory_vs_sales():
    latest, prior = _compounder()[:2]  # inventory grows with revenue
    assert inventory_vs_sales(latest, prior).passed
    latest.values[Metric.INVENTORY] = _nv(latest.values[Metric.INVENTORY].value * 1.5)
    c = inventory_vs_sales(latest, prior)
    assert not c.passed and c.value > 5 and "piling up" in c.note
    services = [_period(2025, revenue=110), _period(2024, revenue=100)]
    assert inventory_vs_sales(*services).passed and "Not applicable" in inventory_vs_sales(*services).note
    assert inventory_vs_sales(latest, None).passed is None


def test_net_cash():
    c = net_cash(_period(2025, cash_and_equivalents=300, short_term_investments=50, long_term_debt=100), "EUR")
    assert c.value == 250 and c.passed and c.display.startswith("EUR 250")
    assert not net_cash(_period(2025, cash_and_equivalents=30, long_term_debt=100), "USD").passed
    # No debt tag and liabilities > equity: can't tell.
    assert net_cash(_period(2025, cash_and_equivalents=30, total_liabilities=900, stockholders_equity=100), "USD").passed is None


def test_gross_margin_level_and_sga_stability():
    assert gross_margin_level(_period(2025, revenue=100, cost_of_goods_sold=55)).passed
    assert not gross_margin_level(_period(2025, revenue=100, cost_of_goods_sold=65)).passed
    assert sga_stability(_compounder()).passed  # constant 15% of revenue
    rising = _compounder()
    rising[0].values[Metric.SGA_EXPENSE] = _nv(rising[0].values[Metric.REVENUE].value * 0.25)
    assert not sga_stability(rising).passed
    falling = _compounder()
    falling[0].values[Metric.SGA_EXPENSE] = _nv(falling[0].values[Metric.REVENUE].value * 0.05)
    assert sga_stability(falling).passed  # a big drop isn't "unstable" in the bad sense


def test_fcf_yield():
    p = _compounder()[0]  # FCF 150, 100 shares, debt 100, cash 300
    c = fcf_yield(p, _price(30.0), "USD")  # EV = 3000 + 100 − 300 = 2800
    assert c.value == pytest.approx(150 / 2800 * 100) and c.passed
    assert not fcf_yield(p, _price(60.0), "USD").passed
    assert fcf_yield(p, PriceContext(None, False, "no price"), "USD").passed is None
    assert fcf_yield(p, _price(1.0), "USD").passed is None  # cash exceeds market cap + debt


def test_every_legend_carries_historical_context():
    for checklist in evaluate(_compounder(), _price(30.0), "USD"):
        context = checklist.context
        assert context is LEGEND_CONTEXT[checklist.key]
        assert context.case_study.summary and context.approach and context.tenure
        known = {c.key for c in checklist.criteria}
        assert set(context.case_study.illustrates) <= known  # case studies point at this legend's own criteria
        assert set(context.metric_rationale) == known  # every check explains why the legend cares
        assert context.allocations


def test_criteria_carry_a_formatted_raw_value():
    by_name = {c.key: c for c in evaluate(_compounder(margin=0.45, share_shrink=0.02), _price(30.0), "USD")}
    labels = {c.key: c.value_label for checklist in by_name.values() for c in checklist.criteria}
    assert labels["piotroski"].endswith("/9") and labels["roic"].endswith("%") and labels["leverage"].endswith("×")
    assert labels["share_count"].startswith("−")  # typographic minus
    assert labels["recurring_fcf"] == "5/5 yrs" and labels["net_cash"].startswith("USD ")
    assert all(labels.values())
