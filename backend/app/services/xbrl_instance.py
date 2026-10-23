"""Fills gaps in SEC CompanyFacts straight from the filings' own XBRL instance documents.

CompanyFacts sometimes never absorbs a filing that EDGAR holds with full XBRL: TSMC's FY2025 20-F
(filed 2026-04-16) contributed two cover-page facts and none of its statements, and many 2026 10-Qs,
20-Fs and 40-Fs are missing outright. `missing_filings` finds those filings from the Submissions index;
`parse_instance` turns one instance document into CompanyFacts-shaped facts that merge with the rest.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date
from typing import Any

# Forms whose statements the pipeline reads (gaap_mapping's annual and quarterly sets).
STATEMENT_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A", "10-Q", "10-Q/A"}

# A filing that put fewer non-cover facts than this into CompanyFacts was not absorbed.
_ABSORBED_MIN_FACTS = 20
_LOOKBACK_DAYS = 3 * 365
_MAX_FILINGS = 6  # newest gaps first; each instance runs to megabytes

# CompanyFacts carries only the standard taxonomies, keyed by these names.
_TAXONOMIES = (
    ("fasb.org/us-gaap/", "us-gaap"),
    ("/ifrs-full", "ifrs-full"),
    ("xbrl.sec.gov/dei/", "dei"),
    ("fasb.org/srt/", "srt"),
)

_XBRLI = "{http://www.xbrl.org/2003/instance}"
_XSI_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"


def _taxonomy_of(namespace: str) -> str | None:
    return next((name for marker, name in _TAXONOMIES if marker in namespace), None)


def missing_filings(submissions: dict[str, Any], company_facts: dict[str, Any], today: date | None = None) -> list[dict[str, str]]:
    """Recent XBRL statement filings that CompanyFacts holds (almost) nothing from, newest first."""
    absorbed: dict[str, int] = {}
    for taxonomy, concepts in company_facts.get("facts", {}).items():
        if taxonomy == "dei":
            continue
        for concept in concepts.values():
            for facts in concept.get("units", {}).values():
                for fact in facts:
                    accn = fact.get("accn")
                    if accn:
                        absorbed[accn] = absorbed.get(accn, 0) + 1

    cutoff = date.fromordinal((today or date.today()).toordinal() - _LOOKBACK_DAYS).isoformat()
    recent = submissions.get("filings", {}).get("recent", {})
    gaps: list[dict[str, str]] = []
    for i, form in enumerate(recent.get("form", [])):
        if form not in STATEMENT_FORMS or not recent["isXBRL"][i] or recent["filingDate"][i] < cutoff:
            continue
        accession = recent["accessionNumber"][i]
        if absorbed.get(accession, 0) < _ABSORBED_MIN_FACTS:
            gaps.append({"accn": accession, "form": form, "filed": recent["filingDate"][i], "primary": recent["primaryDocument"][i]})
    gaps.sort(key=lambda g: g["filed"], reverse=True)
    return gaps[:_MAX_FILINGS]


def instance_file_name(index: dict[str, Any], primary_document: str) -> str | None:
    """The instance document in a filing folder's index.json: the inline-XBRL extract, else the plain .xml."""
    names = [item["name"] for item in index.get("directory", {}).get("item", [])]
    preferred = f"{primary_document.rsplit('.', 1)[0]}_htm.xml"
    if preferred in names:
        return preferred
    extracted = [n for n in names if n.endswith("_htm.xml")]
    if extracted:
        return extracted[0]
    plain = [
        n for n in names
        if n.endswith(".xml") and n != "FilingSummary.xml" and not n.rsplit(".", 1)[0].endswith(("_cal", "_def", "_lab", "_pre"))
    ]
    return plain[0] if plain else None


def _unit_name(unit: ET.Element) -> str | None:
    def measure(el: ET.Element | None) -> str | None:
        return el.text.strip().rpartition(":")[2] if el is not None and el.text else None

    divide = unit.find(f"{_XBRLI}divide")
    if divide is None:
        return measure(unit.find(f"{_XBRLI}measure"))
    numerator = measure(divide.find(f"{_XBRLI}unitNumerator/{_XBRLI}measure"))
    denominator = measure(divide.find(f"{_XBRLI}unitDenominator/{_XBRLI}measure"))
    return f"{numerator}/{denominator}" if numerator and denominator else None


def _number(text: str) -> int | float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return int(value) if value.is_integer() else value


def parse_instance(xml: bytes, accn: str, form: str, filed: str) -> dict[str, Any]:
    """CompanyFacts-shaped facts ({"facts": {taxonomy: {concept: {"units": {unit: [fact]}}}}}) from one filing.

    Only non-dimensional contexts are kept, as in CompanyFacts; duplicates of one fact are dropped.
    """
    root = ET.fromstring(xml)

    contexts: dict[str, dict[str, str]] = {}
    for ctx in root.iter(f"{_XBRLI}context"):
        entity = ctx.find(f"{_XBRLI}entity")
        if ctx.find(f"{_XBRLI}scenario") is not None or (entity is not None and entity.find(f"{_XBRLI}segment") is not None):
            continue  # dimensional (segment, member) values
        period = ctx.find(f"{_XBRLI}period")
        if period is None:
            continue
        instant = period.findtext(f"{_XBRLI}instant")
        start, end = period.findtext(f"{_XBRLI}startDate"), period.findtext(f"{_XBRLI}endDate")
        if instant:
            contexts[ctx.get("id", "")] = {"end": instant.strip()}
        elif start and end:
            contexts[ctx.get("id", "")] = {"start": start.strip(), "end": end.strip()}

    units = {u.get("id", ""): name for u in root.iter(f"{_XBRLI}unit") if (name := _unit_name(u))}

    # Cover facts give every fact of the filing its fiscal year and period, as CompanyFacts does.
    cover: dict[str, str] = {}
    for el in root:
        if el.tag.startswith("{") and _taxonomy_of(el.tag[1:].partition("}")[0]) == "dei" and el.text:
            cover.setdefault(el.tag.partition("}")[2], el.text.strip())
    fy_text = cover.get("DocumentFiscalYearFocus") or cover.get("DocumentPeriodEndDate", "")[:4]
    fy = int(fy_text) if fy_text.isdigit() else None
    fp = cover.get("DocumentFiscalPeriodFocus") or ("FY" if form.split("/")[0] in {"10-K", "20-F", "40-F"} else None)

    facts: dict[str, Any] = {}
    seen: set[tuple[str, str, str, str | None, str]] = set()
    for el in root:
        if not el.tag.startswith("{") or el.get(_XSI_NIL) == "true" or el.text is None:
            continue
        namespace, _, concept = el.tag[1:].partition("}")
        taxonomy = _taxonomy_of(namespace)
        context = contexts.get(el.get("contextRef", ""))
        unit = units.get(el.get("unitRef", ""))
        if taxonomy is None or context is None or unit is None:
            continue  # company extensions, dimensional values, text blocks
        value = _number(el.text.strip())
        if value is None:
            continue
        key = (taxonomy, concept, unit, context.get("start"), context["end"])
        if key in seen:
            continue
        seen.add(key)
        fact = {**context, "val": value, "accn": accn, "fy": fy, "fp": fp, "form": form, "filed": filed}
        facts.setdefault(taxonomy, {}).setdefault(concept, {"units": {}})["units"].setdefault(unit, []).append(fact)
    return {"facts": facts}
