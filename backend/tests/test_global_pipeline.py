"""Dual-pipeline routing, the FMP client and the FMP → internal metric mapping."""

import httpx
import pytest

from app.core.config import Settings
from app.services.data_router import DataRouter, DataSource
from app.services.financials_service import FinancialsService
from app.services.fmp_client import FmpClient, FmpError, FmpNotConfiguredError, FmpPlanError, FmpStatements
from app.services.fmp_mapping import DERIVED_FMP_LIABILITIES_TAG, normalize_fmp_statements
from app.services.forensics import compute_forensics
from app.services.gaap_mapping import Metric, PeriodType
from app.services.listings import parse_listing, sec_ticker_candidate
from app.services.sec_client import SecEdgarClient
from app.services.variance import compute_variances, find_prior_year_period

# ---------------------------------------------------------------- listings


@pytest.mark.parametrize(
    "symbol, local, country",
    [("ASML.AS", "ASML", "NL"), ("vod.l", "VOD", "GB"), ("7203.T", "7203", "JP"), ("NOVO-B.CO", "NOVO-B", "DK"), ("SHOP.TO", "SHOP", "CA")],
)
def test_parses_international_listings(symbol, local, country):
    listing = parse_listing(symbol)
    assert listing is not None and (listing.local_symbol, listing.exchange.country) == (local, country)


@pytest.mark.parametrize("symbol", ["TSLA", "BRK.B", "BF.B", "320193", ".L", "ABC.XYZ"])
def test_us_tickers_share_classes_and_ciks_are_not_international(symbol):
    assert parse_listing(symbol) is None


def test_sec_ticker_candidates():
    assert sec_ticker_candidate(parse_listing("SAN.PA")) == ("SNY", True)  # curated: SAN on EDGAR is Santander
    assert sec_ticker_candidate(parse_listing("VOD.L")) == ("VOD", False)
    assert sec_ticker_candidate(parse_listing("6501.T")) is None  # numeric codes never match EDGAR tickers


# ---------------------------------------------------------------- routing

TICKERS = {
    "0": {"cik_str": 1318605, "ticker": "TSLA", "title": "Tesla, Inc."},
    "1": {"cik_str": 937966, "ticker": "ASML", "title": "ASML HOLDING NV"},
    "2": {"cik_str": 839923, "ticker": "VOD", "title": "VODAFONE GROUP PUBLIC LTD CO"},
    "3": {"cik_str": 1596532, "ticker": "MC", "title": "Moelis & Co"},
    "4": {"cik_str": 891478, "ticker": "SAN", "title": "BANCO SANTANDER, S.A."},
    "5": {"cik_str": 1121404, "ticker": "SNY", "title": "Sanofi"},
}
SUBMISSIONS = {
    937966: {"name": "ASML HOLDING NV", "tickers": ["ASML"], "stateOfIncorporation": "", "addresses": {"business": {"stateOrCountry": "P7"}}},
    # Vodafone's EDGAR record has no country at all — it qualifies as a foreign private issuer.
    839923: {"name": "VODAFONE", "tickers": ["VOD"], "stateOfIncorporation": "", "addresses": {"business": {}}, "filings": {"recent": {"form": ["6-K", "20-F"]}}},
    1596532: {"name": "Moelis & Co", "tickers": ["MC"], "stateOfIncorporation": "DE", "addresses": {"business": {"stateOrCountry": "NY"}}},
    891478: {"name": "BANCO SANTANDER", "tickers": ["SAN"], "stateOfIncorporation": "U3", "addresses": {"business": {"stateOrCountry": "U3"}}},
}


def _sec_client():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/files/company_tickers.json":
            return httpx.Response(200, json=TICKERS)
        if request.url.path.startswith("/submissions/"):
            cik = int(request.url.path.split("CIK")[1].removesuffix(".json"))
            return httpx.Response(200, json=SUBMISSIONS[cik]) if cik in SUBMISSIONS else httpx.Response(404)
        return httpx.Response(404)

    return SecEdgarClient(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    "symbol, source, cik",
    [
        ("TSLA", DataSource.SEC, 1318605),  # US ticker
        ("ASML.AS", DataSource.SEC, 937966),  # foreign SEC registrant, country matches (P7 = Netherlands)
        ("VOD.L", DataSource.SEC, 839923),  # no country on file, but files 20-F/6-K
        ("SAN.PA", DataSource.SEC, 1121404),  # curated: Sanofi, not Santander
        ("MC.PA", DataSource.FMP, None),  # LVMH must not resolve to Moelis & Co (US)
        ("SAN.MC", DataSource.SEC, 891478),  # Santander in Madrid does match (U3 = Spain)
        ("BMW.DE", DataSource.FMP, None),  # not on EDGAR at all
        ("7203.T", DataSource.FMP, None),  # curated → TM, but TM isn't in this test's ticker map
    ],
)
async def test_router_picks_the_pipeline(symbol, source, cik):
    sec = _sec_client()
    route = await DataRouter(sec).resolve(symbol)
    await sec.aclose()
    assert (route.source, route.cik) == (source, cik)


# ---------------------------------------------------------------- FMP client


def _fmp(handler, key="test-key"):
    settings = Settings(_env_file=None, FMP_API_KEY=key) if key else Settings(_env_file=None)
    return FmpClient(settings, transport=httpx.MockTransport(handler))


async def test_fmp_requires_a_key():
    client = _fmp(lambda r: httpx.Response(200, json=[]), key=None)
    with pytest.raises(FmpNotConfiguredError) as exc:
        await client.get_statements("BMW.DE", PeriodType.ANNUAL)
    assert exc.value.status_code == 503
    await client.aclose()


async def test_fmp_free_plan_us_only_becomes_a_402_without_leaking_the_key():
    client = _fmp(lambda r: httpx.Response(402, text="Premium Query: this value is only available for US stocks only on the free plan"))
    with pytest.raises(FmpPlanError) as exc:
        await client.get_statements("BMW.DE", PeriodType.ANNUAL)
    assert exc.value.status_code == 402 and "test-key" not in str(exc.value)
    await client.aclose()


async def test_fmp_retries_at_the_free_plan_period_cap():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.url.params["limit"], request.url.params["period"]))
        if request.url.params["limit"] != "5":
            return httpx.Response(402, json={"Error Message": "Premium Query Parameter: limit must be at most 5"})
        return httpx.Response(200, json=[{"date": "2024-12-31", "revenue": 1}])

    client = _fmp(handler)
    statements = await client.get_statements("AAPL", PeriodType.ANNUAL)
    await client.aclose()
    assert statements.income == [{"date": "2024-12-31", "revenue": 1}]
    assert ("/stable/income-statement", "5", "annual") in seen


async def test_fmp_invalid_key_and_quota_errors():
    for body, status in [({"Error Message": "Invalid API KEY."}, 503), ({"Error Message": "Limit Reach . Please upgrade"}, 429)]:
        client = _fmp(lambda r, body=body: httpx.Response(200 if status == 503 else 429, json=body))
        with pytest.raises(FmpError) as exc:
            await client.get_profile("BMW.DE")
        assert exc.value.status_code == status
        await client.aclose()


# ---------------------------------------------------------------- FMP mapping


def _income(date, fy, revenue, op_income, net_income, shares=1_000, cogs=None, currency="EUR"):
    return {
        "date": date, "fiscalYear": str(fy), "period": "FY", "reportedCurrency": currency, "filingDate": f"{fy + 1}-03-01",
        "revenue": revenue, "costOfRevenue": cogs if cogs is not None else revenue * 0.6, "operatingIncome": op_income,
        "netIncome": net_income + 5, "bottomLineNetIncome": net_income, "weightedAverageShsOutDil": shares,
    }  # fmt: skip


def _balance(date, assets, current_assets, current_liabilities, equity, retained, ltd, currency="EUR", liabilities=None):
    return {
        "date": date, "period": "FY", "reportedCurrency": currency,
        "cashAndCashEquivalents": 100, "shortTermInvestments": 0, "accountsReceivables": 200, "inventory": 300,
        "totalCurrentAssets": current_assets, "totalAssets": assets, "totalCurrentLiabilities": current_liabilities,
        "totalLiabilities": liabilities if liabilities is not None else assets - equity,
        "totalLiabilitiesAndTotalEquity": assets, "totalEquity": equity + 10,
        "totalStockholdersEquity": equity, "retainedEarnings": retained, "longTermDebt": ltd,
    }  # fmt: skip


def _cash(date, ocf, capex, currency="EUR"):
    return {"date": date, "period": "FY", "reportedCurrency": currency, "operatingCashFlow": ocf, "capitalExpenditure": -capex, "freeCashFlow": ocf - capex}


def _bmw_like():
    return FmpStatements(
        income=[
            _income("2024-12-31", 2024, 142_000, 11_000, 7_200),
            _income("2023-12-31", 2023, 155_000, 18_500, 11_300),
            _income("2022-12-31", 2022, 142_600, 13_900, 17_900),
        ],
        balance=[
            _balance("2024-12-31", 270_000, 110_000, 95_000, 92_000, 85_000, 70_000, liabilities=0),
            _balance("2023-12-31", 265_000, 108_000, 90_000, 91_000, 82_000, 66_000),
            _balance("2022-12-31", 250_000, 100_000, 88_000, 88_000, 75_000, 60_000),
        ],
        cash_flow=[_cash("2024-12-31", 12_000, 9_000), _cash("2023-12-31", 16_000, 8_000), _cash("2022-12-31", 23_000, 6_000)],
    )


def test_maps_fmp_fields_onto_internal_metrics():
    result = normalize_fmp_statements(_bmw_like(), PeriodType.ANNUAL)
    fy24, fy23, fy22 = result.periods
    v = {m: x.value for m, x in fy24.values.items()}
    assert result.currency == "EUR"
    assert (fy24.start, fy24.end, fy24.fiscal_year, fy24.fiscal_period) == ("2024-01-01", "2024-12-31", 2024, "FY")
    assert v[Metric.NET_INCOME] == 7_200  # bottomLineNetIncome (attributable), not netIncome
    assert v[Metric.CAPITAL_EXPENDITURES] == 9_000  # FMP's negative outflow, made positive
    assert v[Metric.FREE_CASH_FLOW] == 3_000
    assert v[Metric.SHORT_TERM_INVESTMENTS] == 0  # a real zero is kept
    # totalLiabilities came back 0 (unreported): derived from totalLiabilitiesAndTotalEquity − totalEquity.
    assert v[Metric.TOTAL_LIABILITIES] == 270_000 - 92_010
    assert fy24.values[Metric.TOTAL_LIABILITIES].source_tag == DERIVED_FMP_LIABILITIES_TAG
    assert fy24.values[Metric.REVENUE].source_tag == "income-statement.revenue"
    assert fy24.values[Metric.REVENUE].accession_number is None
    assert fy24.opening_balances[Metric.TOTAL_ASSETS].value == 265_000
    assert fy22.opening_balances == {}  # no older balance sheet returned


def test_altman_piotroski_and_variance_run_on_fmp_periods():
    periods = normalize_fmp_statements(_bmw_like(), PeriodType.ANNUAL).periods
    fy24 = periods[0]
    variance = compute_variances(periods, 0.10)[fy24.key]
    assert variance[Metric.NET_INCOME].flagged and variance[Metric.NET_INCOME].severity_tier == 3  # −36.3%
    assert not variance[Metric.REVENUE].flagged  # −8.4%

    f = compute_forensics(fy24, find_prior_year_period(fy24, periods))
    assert f.piotroski.available == 9 and f.piotroski.score is not None
    assert f.altman_z.value is not None and f.altman_z.zone is not None
    assert f.sloan_accruals_pct.value is not None


def test_unreported_zeros_are_missing_and_other_currencies_dropped():
    statements = FmpStatements(
        income=[_income("2024-12-31", 2024, 1_000, 0, 50, cogs=0), _income("2023-12-31", 2023, 900, 80, 40, currency="USD")],
        balance=[_balance("2024-12-31", 5_000, 2_000, 1_000, 3_000, 0, 0)],
        cash_flow=[_cash("2024-12-31", 0, 0)],
    )
    result = normalize_fmp_statements(statements, PeriodType.ANNUAL)
    (fy24,) = result.periods  # the USD row isn't mixed into a EUR history
    for metric in (Metric.COST_OF_GOODS_SOLD, Metric.OPERATING_INCOME, Metric.RETAINED_EARNINGS, Metric.OPERATING_CASH_FLOW):
        assert metric not in fy24.values
    assert fy24.values[Metric.LONG_TERM_DEBT].value == 0 and fy24.values[Metric.CAPITAL_EXPENDITURES].value == 0


# ---------------------------------------------------------------- service, end to end


async def test_service_serves_an_international_listing_from_fmp():
    sec = _sec_client()
    rows = {"income-statement": _bmw_like().income, "balance-sheet-statement": _bmw_like().balance, "cash-flow-statement": _bmw_like().cash_flow}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["symbol"] == "BMW.DE"
        name = request.url.path.rsplit("/", 1)[1]
        if name == "profile":
            return httpx.Response(200, json=[{"companyName": "Bayerische Motoren Werke AG", "exchangeFullName": "XETRA", "country": "DE", "industry": "Auto - Manufacturers"}])
        return httpx.Response(200, json=rows[name])

    fmp = _fmp(handler)
    service = FinancialsService(sec, fmp)
    financials = await service.get_financials("bmw.de", PeriodType.ANNUAL, limit=10)
    profile = await service.get_profile("BMW.DE")
    await sec.aclose()
    await fmp.aclose()

    assert (financials.source, financials.currency, financials.accounting_standard, financials.cik) == ("fmp", "EUR", "FMP standardized", None)
    assert financials.entity_name == "Bayerische Motoren Werke AG"
    latest = financials.periods[0]
    assert latest.line_items["revenue"].value == 142_000
    assert latest.ratios["current_ratio"].value == pytest.approx(110_000 / 95_000)
    assert latest.forensics.altman_z.value is not None
    assert latest.variances["net_income"].flagged
    assert (profile.symbol, profile.tickers, profile.cik, profile.source) == ("BMW.DE", ["BMW.DE"], None, "fmp")
