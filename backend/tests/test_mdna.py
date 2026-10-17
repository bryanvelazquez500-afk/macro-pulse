import pytest

from app.services.mdna import MdnaNotFoundError, extract_item_7, html_to_text, latest_annual_report

BODY = "Revenue grew because of strong demand. " * 80  # > MIN_MDNA_CHARS

FILING_HTML = f"""
<html><head><title>10-K</title><style>.x{{color:red}}</style></head><body>
<div style="display:none"><ix:header><ix:hidden>dei:EntityRegistrantName Apple</ix:hidden></ix:header></div>
<table>
  <tr><td>Item 7.</td></tr><tr><td>Management&#8217;s Discussion and Analysis of Financial Condition</td><td>20</td></tr>
  <tr><td>Item 7A.</td></tr><tr><td>Quantitative and Qualitative Disclosures About Market Risk</td><td>30</td></tr>
</table>
<p>Item 1A. Risk Factors. See Part II, &#8220;Item 7. Management&#8217;s Discussion and Analysis&#8221; for details.</p>
<p><span>Item&#160;7.&#160;Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations</span></p>
<p>{BODY}</p>
<p>Refer to Part II, &#8220;Item 8. Financial Statements and Supplementary Data&#8221; for the notes.</p>
<p>Supply constraints eased during the year.</p>
<p>Item 7A. Quantitative and Qualitative Disclosures About Market Risk</p>
<p>Interest rate risk...</p>
<p>Item 8. Financial Statements and Supplementary Data</p>
</body></html>
"""


def test_html_to_text_drops_hidden_xbrl_and_styles():
    text = html_to_text(FILING_HTML)
    assert "dei:EntityRegistrantName" not in text
    assert "color:red" not in text
    assert "Management’s Discussion" in text  # entities decoded


def test_extracts_body_not_table_of_contents_or_cross_references():
    mdna = extract_item_7(html_to_text(FILING_HTML))
    assert mdna.startswith("Item 7. Management’s Discussion and Analysis of Financial Condition and Results")
    # A mid-sentence "Item 8" reference must not end the section early.
    assert mdna.rstrip().endswith("Supply constraints eased during the year.")
    assert "Interest rate risk" not in mdna


def test_incorporated_by_reference_raises():
    stub = "<p>Item 7. Management's Discussion and Analysis</p><p>Incorporated by reference to Exhibit 13.</p><p>Item 8. Financial Statements</p>"
    with pytest.raises(MdnaNotFoundError):
        extract_item_7(html_to_text(stub))


def test_latest_annual_report_skips_other_forms():
    submissions = {
        "filings": {
            "recent": {
                "form": ["10-Q", "8-K", "10-K", "10-K"],
                "accessionNumber": ["a", "b", "0000320193-25-000079", "old"],
                "filingDate": ["2026-07-31", "2026-07-30", "2025-10-31", "2024-11-01"],
                "reportDate": ["2026-06-27", "", "2025-09-27", "2024-09-28"],
                "primaryDocument": ["q.htm", "k.htm", "aapl-20250927.htm", "old.htm"],
            }
        }
    }
    ref = latest_annual_report(submissions, 320193)
    assert ref.accession_number == "0000320193-25-000079"
    assert ref.url == "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm"


def test_no_10k_raises():
    with pytest.raises(MdnaNotFoundError):
        latest_annual_report({"filings": {"recent": {"form": ["20-F"]}}}, 1)
