import json
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.services.mdna import FilingRef
from app.services.narrative import NarrativeError, NarrativeService, Theme, build_user_message, parse_bullets

MDNA = (
    "Item 7. Management’s Discussion and Analysis\n"
    "Gross margin declined due to higher component costs. "
    "We continued to shift manufacturing to India and Vietnam. "
    "Tariffs could materially affect future results. "
    "Services revenue grew 14%. "
) * 30

BULLETS = [
    {"theme": "operational_headwind", "headline": "Margin pressure", "detail": "Costs rose.", "evidence_quote": "Gross margin declined due to higher component costs."},
    {"theme": "supply_chain", "headline": "Assembly diversifies", "detail": "India, Vietnam.", "evidence_quote": "We continued to shift  manufacturing to India and Vietnam."},
    {"theme": "forward_risk", "headline": "Tariff exposure", "detail": "Tariffs.", "evidence_quote": "Tariffs could materially affect future results."},
    {"theme": "forward_risk", "headline": "Invented", "detail": "Not in text.", "evidence_quote": "Management expects a recession in 2027."},
]


def _response(payload, stop_reason="end_turn"):
    return SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=json.dumps(payload))])


def test_parse_bullets_verifies_quotes_against_mdna():
    bullets = parse_bullets(_response({"bullets": BULLETS}), MDNA)
    assert [b.theme for b in bullets] == [Theme.OPERATIONAL_HEADWIND, Theme.SUPPLY_CHAIN, Theme.FORWARD_RISK, Theme.FORWARD_RISK]
    assert [b.quote_verified for b in bullets] == [True, True, True, False]  # whitespace-insensitive match


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (_response({"bullets": BULLETS}, stop_reason="refusal"), "declined"),
        (_response({"bullets": BULLETS}, stop_reason="max_tokens"), "cut off"),
        (_response({"bullets": BULLETS[:2]}), "2 bullets"),
        (SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text="not json")]), "malformed"),
    ],
)
def test_parse_bullets_errors(response, message):
    with pytest.raises(NarrativeError, match=message):
        parse_bullets(response, MDNA)


def test_user_message_puts_document_before_instruction():
    filing = FilingRef("10-K", "acc", "2025-10-31", "2025-09-27", "https://www.sec.gov/x")
    msg = build_user_message("Apple Inc.", filing, MDNA)
    assert msg.index("<mdna") < msg.index("</mdna>") < msg.index("Write the 4 executive bullets")


class FakeSec:
    def __init__(self):
        self.document_fetches = 0

    async def resolve_cik(self, identifier):
        return 320193

    async def get_submissions(self, cik):
        return {
            "name": "Apple Inc.",
            "filings": {"recent": {
                "form": ["10-K"], "accessionNumber": ["0000320193-25-000079"], "filingDate": ["2025-10-31"],
                "reportDate": ["2025-09-27"], "primaryDocument": ["aapl-20250927.htm"],
            }},
        }

    async def get_filing_document(self, url):
        self.document_fetches += 1
        return f"<p>Item 7. Management’s Discussion and Analysis</p><p>{MDNA}</p><p>Item 8. Financial Statements</p>"


class FakeClaude:
    def __init__(self):
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        return _response({"bullets": BULLETS})


async def test_summarize_calls_claude_once_per_filing():
    sec, claude = FakeSec(), FakeClaude()
    service = NarrativeService(sec, claude, Settings())
    first = await service.summarize("AAPL")
    second = await service.summarize("AAPL")

    assert first is second and len(claude.calls) == 1 and sec.document_fetches == 1
    call = claude.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert "Gross margin declined" in call["messages"][0]["content"]
    assert first.filing.accession_number == "0000320193-25-000079"
    assert len(first.bullets) == 4


async def test_missing_api_key_is_a_clear_503():
    service = NarrativeService(FakeSec(), None, Settings())
    with pytest.raises(NarrativeError, match="ANTHROPIC_API_KEY") as exc:
        await service.summarize("AAPL")
    assert exc.value.status_code == 503
