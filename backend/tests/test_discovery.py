import httpx
import pytest

from app.core.config import Settings
from app.services import discovery
from app.services.data_router import DataRouter
from app.services.fmp_client import FmpClient
from app.services.listings import parse_listing
from app.services.quotes import QuoteService
from app.services.sec_client import SecEdgarClient


def test_every_curated_symbol_is_routable():
    for iso, entries in discovery.LEADERS.items():
        assert len(iso) == 2 and iso.isupper()
        assert 3 <= len(entries) <= 80
        for symbol, name, sector in entries:
            assert sector in discovery.SECTORS, (symbol, sector)
            suffix = symbol.rpartition(".")[2] if "." in symbol else None
            # Exchange suffixes must be known to the router (otherwise "0700.HK" would be treated as a US ticker).
            assert suffix in (None, "B") or parse_listing(symbol) is not None, symbol
            assert name


async def test_country_leaders_combines_snapshots_and_coverage(monkeypatch):
    monkeypatch.setitem(discovery.LEADERS, "ZZ", [("AAPL", "Apple", "Technology"), ("VOD.L", "Vodafone", "Communication Services"), ("0700.HK", "Tencent", "Communication Services")])

    def yahoo(request: httpx.Request) -> httpx.Response:
        sym = request.url.path.rsplit("/", 1)[1]
        if sym == "0700.HK":
            return httpx.Response(404)
        meta = {"regularMarketPrice": 120.0, "chartPreviousClose": 100.0, "currency": "GBp" if sym == "VOD.L" else "USD",
                "fiftyTwoWeekLow": 80.0, "fiftyTwoWeekHigh": 150.0, "longName": sym}  # fmt: skip
        return httpx.Response(200, json={"chart": {"result": [{"meta": meta}]}})

    def sec(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/files/company_tickers.json":
            return httpx.Response(200, json={"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple"}, "1": {"cik_str": 839923, "ticker": "VOD", "title": "Vodafone"}})
        return httpx.Response(200, json={"stateOfIncorporation": "X0", "addresses": {"business": {}}})

    settings = Settings(_env_file=None)
    sec_client = SecEdgarClient(transport=httpx.MockTransport(sec))
    fmp = FmpClient(settings)
    quotes = QuoteService(fmp, settings, transport=httpx.MockTransport(yahoo))
    leaders = await discovery.country_leaders("zz", quotes, DataRouter(sec_client), fmp)
    await quotes.aclose(); await fmp.aclose(); await sec_client.aclose()  # fmt: skip

    apple, vod, tencent = leaders
    assert (apple.rank, apple.sector, apple.coverage, apple.snapshot.change_pct) == (1, "Technology", "sec", pytest.approx(20.0))
    assert (vod.coverage, vod.snapshot.price, vod.snapshot.currency, vod.snapshot.week52_high) == ("sec", pytest.approx(1.2), "GBP", pytest.approx(1.5))
    assert (tencent.snapshot, tencent.coverage) == (None, "fmp_key_required")
    assert await discovery.country_leaders("XX", quotes, DataRouter(sec_client), fmp) is None


def test_symbols_are_unique_across_countries():
    symbols = [s for entries in discovery.LEADERS.values() for s, _, _ in entries]
    assert len(symbols) == len(set(symbols))
