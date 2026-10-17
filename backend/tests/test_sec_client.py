import httpx
import pytest

from app.services.sec_client import CompanyNotFoundError, SecEdgarClient, format_cik


def test_format_cik_pads_to_ten_digits():
    assert format_cik(320193) == "0000320193"
    assert format_cik("0000320193") == "0000320193"


async def test_requests_send_sec_user_agent_and_hit_correct_urls():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/files/company_tickers.json":
            return httpx.Response(200, json={"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}})
        return httpx.Response(200, json={"name": "Apple Inc."})

    client = SecEdgarClient(transport=httpx.MockTransport(handler))
    cik = await client.resolve_cik("aapl")
    await client.get_submissions(cik)
    await client.get_company_facts(cik)
    await client.aclose()

    assert cik == 320193
    assert [str(r.url) for r in seen] == [
        "https://www.sec.gov/files/company_tickers.json",
        "https://data.sec.gov/submissions/CIK0000320193.json",
        "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    ]
    assert all(r.headers["User-Agent"] == "InvestmentStation student@domain.com" for r in seen)


async def test_unknown_ticker_raises_not_found():
    client = SecEdgarClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    with pytest.raises(CompanyNotFoundError):
        await client.resolve_cik("ZZZZZZ")
    await client.aclose()


def test_cors_origins_accept_comma_separated_or_json(monkeypatch):
    from app.core.config import Settings

    monkeypatch.setenv("IS_CORS_ORIGINS", "https://app.macropulse.example/, https://www.macropulse.example")
    assert Settings(_env_file=None).cors_origins == ["https://app.macropulse.example", "https://www.macropulse.example"]
    monkeypatch.setenv("IS_CORS_ORIGINS", '["https://a.example"]')
    assert Settings(_env_file=None).cors_origins == ["https://a.example"]
    monkeypatch.delenv("IS_CORS_ORIGINS")
    assert Settings(_env_file=None).cors_origins == ["http://localhost:3000", "http://127.0.0.1:3000"]
