"""Price comparability, split adjustment and quote sourcing."""

import httpx
import pytest

from app.core.config import Settings
from app.services.fmp_client import FmpClient
from app.services.gaap_mapping import Metric, detect_share_splits, normalize_company_facts
from app.services.pricing import price_context
from app.services.quotes import Quote, QuoteService, normalize_price, yahoo_symbol


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
