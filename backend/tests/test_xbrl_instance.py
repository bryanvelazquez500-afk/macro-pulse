from datetime import date

import httpx

from app.services.sec_client import SecEdgarClient
from app.services.xbrl_instance import instance_file_name, missing_filings, parse_instance

INSTANCE = b"""<?xml version="1.0" encoding="utf-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:ifrs-full="https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full" xmlns:dei="http://xbrl.sec.gov/dei/2025"
  xmlns:tsm="http://www.tsmc.com/20251231">
  <xbrli:context id="FY25"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001046179</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="I25"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001046179</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="FY25_seg"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001046179</xbrli:identifier>
    <xbrli:segment><xbrldi:explicitMember dimension="ifrs-full:SegmentsAxis">tsm:WaferMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:unit id="TWD"><xbrli:measure>iso4217:TWD</xbrli:measure></xbrli:unit>
  <xbrli:unit id="TWDPerShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:TWD</xbrli:measure></xbrli:unitNumerator>
    <xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
  <dei:DocumentFiscalYearFocus contextRef="FY25">2025</dei:DocumentFiscalYearFocus>
  <dei:DocumentFiscalPeriodFocus contextRef="FY25">FY</dei:DocumentFiscalPeriodFocus>
  <ifrs-full:Revenue contextRef="FY25" unitRef="TWD" decimals="-5">3809054300000</ifrs-full:Revenue>
  <ifrs-full:Revenue contextRef="FY25" unitRef="TWD" decimals="-5">3809054300000</ifrs-full:Revenue>
  <ifrs-full:Revenue contextRef="FY25_seg" unitRef="TWD" decimals="-5">3000000000000</ifrs-full:Revenue>
  <ifrs-full:Assets contextRef="I25" unitRef="TWD" decimals="-5">7932842500000</ifrs-full:Assets>
  <ifrs-full:DilutedEarningsLossPerShare contextRef="FY25" unitRef="TWDPerShare" decimals="2">65.47</ifrs-full:DilutedEarningsLossPerShare>
  <ifrs-full:Inventories contextRef="I25" unitRef="TWD" xsi:nil="true"/>
  <tsm:CustomRevenue contextRef="FY25" unitRef="TWD" decimals="-5">1</tsm:CustomRevenue>
</xbrli:xbrl>"""


def test_parse_instance_keeps_plain_contexts_in_company_facts_shape():
    facts = parse_instance(INSTANCE, "0001628280-26-025362", "20-F", "2026-04-16")["facts"]

    assert set(facts) == {"ifrs-full"}  # dei has no units here; extensions are dropped
    revenue = facts["ifrs-full"]["Revenue"]["units"]["TWD"]
    assert revenue == [
        {"start": "2025-01-01", "end": "2025-12-31", "val": 3809054300000, "accn": "0001628280-26-025362",
         "fy": 2025, "fp": "FY", "form": "20-F", "filed": "2026-04-16"}
    ]  # duplicate dropped, segment value excluded
    assert "start" not in facts["ifrs-full"]["Assets"]["units"]["TWD"][0]
    assert facts["ifrs-full"]["DilutedEarningsLossPerShare"]["units"]["TWD/shares"][0]["val"] == 65.47
    assert "Inventories" not in facts["ifrs-full"]


def _submissions(*rows):
    keys = ("form", "accessionNumber", "filingDate", "primaryDocument", "isXBRL")
    return {"filings": {"recent": {k: [r[i] for r in rows] for i, k in enumerate(keys)}}}


def test_missing_filings_lists_recent_statement_filings_companyfacts_lacks():
    facts = {"facts": {
        "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [{"accn": "new", "val": 1}]}}},
        "ifrs-full": {"Revenue": {"units": {"TWD": [{"accn": "old", "val": 1}] * 25}}},
    }}
    subs = _submissions(
        ("20-F", "new", "2026-04-16", "tsm-20251231.htm", 1),
        ("6-K", "news", "2026-04-20", "x.htm", 1),
        ("20-F", "old", "2025-04-17", "d896993d20f.htm", 1),
        ("20-F", "ancient", "2020-04-15", "a.htm", 1),
        ("10-K/A", "nonxbrl", "2026-05-01", "b.htm", 0),
    )
    assert [g["accn"] for g in missing_filings(subs, facts, today=date(2026, 10, 22))] == ["new"]


def test_instance_file_name_prefers_the_inline_extract():
    index = {"directory": {"item": [{"name": n} for n in ("FilingSummary.xml", "tsm-20251231_cal.xml", "tsm-20251231_htm.xml", "tsm-20251231.xsd")]}}
    assert instance_file_name(index, "tsm-20251231.htm") == "tsm-20251231_htm.xml"
    legacy = {"directory": {"item": [{"name": n} for n in ("FilingSummary.xml", "abc-20151231_lab.xml", "abc-20151231.xml")]}}
    assert instance_file_name(legacy, "d1.htm") == "abc-20151231.xml"


async def test_company_facts_merge_a_filing_companyfacts_missed():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/api/xbrl/companyfacts/"):
            return httpx.Response(200, json={"entityName": "TSMC", "facts": {"ifrs-full": {"Revenue": {"units": {"TWD": [
                {"start": "2024-01-01", "end": "2024-12-31", "val": 1, "accn": "old", "fy": 2024, "fp": "FY", "form": "20-F", "filed": "2025-04-17"}
            ] * 25}}}}})
        if path.startswith("/submissions/"):
            return httpx.Response(200, json=_submissions(("20-F", "0001628280-26-025362", "2026-04-16", "tsm-20251231.htm", 1)))
        if path.endswith("/index.json"):
            return httpx.Response(200, json={"directory": {"item": [{"name": "tsm-20251231_htm.xml"}]}})
        if path.endswith("/tsm-20251231_htm.xml"):
            return httpx.Response(200, content=INSTANCE)
        return httpx.Response(404)

    client = SecEdgarClient(transport=httpx.MockTransport(handler))
    facts = await client.get_company_facts(1046179)
    await client.aclose()

    revenue = facts["facts"]["ifrs-full"]["Revenue"]["units"]["TWD"]
    assert facts["entityName"] == "TSMC"
    assert {f["fy"] for f in revenue} == {2024, 2025}
