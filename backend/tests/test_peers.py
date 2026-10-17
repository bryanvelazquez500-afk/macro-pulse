import httpx

from app.services.peers import PEER_GROUPS, SIC_MAJOR_GROUP_TO_GROUP, SIC_TO_GROUP, TICKER_OVERRIDES, match_peer_group, suggest_peers
from app.services.sec_client import SecEdgarClient


def test_every_mapping_points_at_a_real_group():
    for key in [*SIC_TO_GROUP.values(), *SIC_MAJOR_GROUP_TO_GROUP.values(), *TICKER_OVERRIDES.values()]:
        assert key in PEER_GROUPS


def test_match_order_ticker_then_sic_then_major_group():
    assert match_peer_group("UBER", "7389").basis == "ticker"  # 7389 alone would say payments
    assert match_peer_group("PYPL", "7389").label == "Payments & Card Networks"
    assert match_peer_group("XYZ", "6022").basis == "sic"
    fallback = match_peer_group("XYZ", "6099")  # unlisted code, major group 60
    assert (fallback.basis, fallback.label) == ("sic_major_group", "Banks")
    assert match_peer_group("XYZ", "9999") is None
    assert match_peer_group(None, None) is None


TICKERS = {
    str(i): {"cik_str": cik, "ticker": t, "title": name}
    for i, (t, cik, name) in enumerate(
        [("AAPL", 320193, "Apple Inc."), ("MSFT", 789019, "MICROSOFT CORP"), ("GOOGL", 1652044, "Alphabet Inc."),
         ("GOOG", 1652044, "Alphabet Inc."), ("NVDA", 1045810, "NVIDIA CORP"), ("AMZN", 1018724, "AMAZON COM INC")]
    )
}  # fmt: skip


async def test_suggest_peers_for_apple_excludes_itself_and_unknown_tickers():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/files/company_tickers.json":
            return httpx.Response(200, json=TICKERS)
        return httpx.Response(200, json={"tickers": ["AAPL"], "sic": "3571", "sicDescription": "Electronic Computers"})

    client = SecEdgarClient(transport=httpx.MockTransport(handler))
    result = await suggest_peers(client, "AAPL", limit=3)
    await client.aclose()
    assert result.group == "Big Tech" and result.basis == "sic"
    assert [p.ticker for p in result.peers] == ["MSFT", "GOOGL", "NVDA"]  # META isn't in this ticker map; AAPL is self
    assert result.peers[0].name == "MICROSOFT CORP"
