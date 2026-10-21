"""US universe: SIC → sector mapping and ticker search."""

from app.services import universe
from app.services.universe import Listing, search, sector_for_sic


def test_sector_for_sic():
    assert sector_for_sic(3674) == "Technology"  # semiconductors
    assert sector_for_sic(2834) == "Healthcare"  # pharmaceuticals
    assert sector_for_sic(6021) == "Financials"  # national banks
    assert sector_for_sic(6798) == "Real Estate"  # REITs
    assert sector_for_sic(1311) == "Energy"  # crude petroleum & natural gas
    assert sector_for_sic(4911) == "Utilities"  # electric services
    assert sector_for_sic(5331) == "Consumer Staples"  # variety stores (Walmart, Target)
    assert sector_for_sic(3711) == "Consumer Discretionary"  # motor vehicles
    assert sector_for_sic(None) is None


def test_search_ranks_exact_then_prefix_then_name(monkeypatch):
    rows = (
        Listing("MSFT", 1, "Microsoft", "Nasdaq", 7372, "Technology"),
        Listing("MU", 2, "Micron Technology", "Nasdaq", 3674, "Technology"),
        Listing("AMD", 3, "Advanced Micro Devices", "Nasdaq", 3674, "Technology"),
        Listing("M", 4, "Macy's", "NYSE", 5311, "Consumer Staples"),
    )
    monkeypatch.setattr(universe, "us_listings", lambda: rows)
    assert [l.ticker for l in search("M")] == ["M", "MU", "MSFT", "AMD"]  # exact, tickers by length, then names
    assert [l.ticker for l in search("micro")] == ["MSFT", "MU", "AMD"]


def test_shipped_universe_is_sane():
    rows = universe.us_listings()
    assert len(rows) > 3000
    tickers = [r.ticker for r in rows]
    assert len(tickers) == len(set(tickers))
    assert {"AAPL", "MSFT", "JPM", "KO"} <= set(tickers)
    assert all(r.sector in universe.__dict__.values() or r.sector for r in rows)
