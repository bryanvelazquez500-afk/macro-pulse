"""Isolates Item 7 (Management's Discussion & Analysis) from a 10-K filing.

10-K primary documents are inline-XBRL HTML. We flatten them to text, then
locate the MD&A body between its "Item 7. Management's Discussion…" heading and
the next "Item 7A" / "Item 8" heading. The same heading also appears in the
table of contents (followed almost immediately by the next item), so of every
candidate span we keep the longest one — that is the real section.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

# MD&A that is shorter than this almost always means the 10-K "incorporates by
# reference" an exhibit (common for banks) rather than including the text.
MIN_MDNA_CHARS = 2_000

_ANNUAL_REPORT_FORMS = ("10-K",)

_BLOCK_TAGS = {
    "p", "div", "br", "tr", "li", "table", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dt", "dd",
}  # fmt: skip
_SKIP_TAGS = {"script", "style", "head", "title"}

# Headings start a line; requiring that skips in-text cross-references such as
# 'see Part II, "Item 8. Financial Statements"'.
_ITEM_7_START = re.compile(
    r"^item\s*7\s*[.:\-–—]?\s*management[’'`s]*\s+discussion\s+and\s+analysis", re.IGNORECASE | re.MULTILINE
)
_ITEM_7_END = re.compile(
    r"^item\s*(?:7a\s*[.:\-–—]?\s*quantitative|8\s*[.:\-–—]?\s*financial\s+statements)",
    re.IGNORECASE | re.MULTILINE,
)


class MdnaNotFoundError(Exception):
    pass


@dataclass(frozen=True)
class FilingRef:
    form: str
    accession_number: str
    filing_date: str
    report_date: str | None
    url: str


@dataclass(frozen=True)
class MdnaSection:
    filing: FilingRef
    text: str


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0
        # Inline XBRL keeps machine-readable facts in a hidden <ix:header>; it isn't prose.
        self._hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag == "ix:header" or self._hidden_depth:
            self._hidden_depth += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br" and not (self._skip_depth or self._hidden_depth):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif self._hidden_depth:
            self._hidden_depth -= 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not (self._skip_depth or self._hidden_depth):
            self.parts.append(data)


def html_to_text(document: str) -> str:
    parser = _TextExtractor()
    parser.feed(document)
    parser.close()
    text = html.unescape("".join(parser.parts)).replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_item_7(text: str) -> str:
    """Returns the longest Item 7 → Item 7A/8 span (the body, not the table-of-contents entry)."""
    ends = [m.start() for m in _ITEM_7_END.finditer(text)]
    best = ""
    for start in _ITEM_7_START.finditer(text):
        end = next((e for e in ends if e > start.end()), None)
        if end is None:
            continue
        candidate = text[start.start() : end].strip()
        if len(candidate) > len(best):
            best = candidate
    if len(best) < MIN_MDNA_CHARS:
        raise MdnaNotFoundError(
            "Item 7 (MD&A) was not found in the 10-K body — it may be incorporated by reference to an exhibit."
        )
    return best


def latest_annual_report(submissions: dict[str, Any], cik: int) -> FilingRef:
    recent = submissions.get("filings", {}).get("recent", {})
    for i, form in enumerate(recent.get("form", [])):
        if form in _ANNUAL_REPORT_FORMS:
            accession = recent["accessionNumber"][i]
            return FilingRef(
                form=form,
                accession_number=accession,
                filing_date=recent["filingDate"][i],
                report_date=recent["reportDate"][i] or None,
                url=f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{recent['primaryDocument'][i]}",
            )
    raise MdnaNotFoundError("No 10-K on file — Item 7 MD&A is only available for domestic annual reports.")
