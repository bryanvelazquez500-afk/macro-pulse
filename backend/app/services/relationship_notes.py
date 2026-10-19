"""Filing-backed context for one supplier → client relationship (the Supply Chain card).

For each side that files annual reports with the SEC (10-K, 20-F, 40-F), the latest report is
scanned for sentences naming the other company. Those sentences are quoted verbatim — nothing is
paraphrased — and any percentages or dollar amounts in them are listed as disclosed figures. A side
without SEC filings (private, or not an SEC registrant) simply has none.

Freshness without churn: results are stored in data/relationship_notes.json together with the filing
they came from. Each request checks the latest annual report (EDGAR submissions, cached by the SEC
client); a filing is downloaded only when it hasn't been read before. If a new filing says the same
thing about the partner, the stored note is left exactly as it was (only the "checked" filing moves
on); if it says something new, the note is replaced and records the filing it superseded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.data_router import DataRouter, DataSource
from app.services.mdna import html_to_text
from app.services.sec_client import SecApiError, SecEdgarClient
from app.services.supply_chain import SupplyChainStore

NOTES_PATH = Path(__file__).resolve().parents[2] / "data" / "relationship_notes.json"
ANNUAL_FORMS = ("10-K", "20-F", "40-F")
MAX_EXCERPTS = 3
LOOKBACK_REPORTS = 3  # latest annual report, plus up to two earlier ones if it doesn't name the partner
MAX_SENTENCE_CHARS = 600

# Sentences that say something about a commercial relationship rank first.
_RELATIONSHIP_WORDS = re.compile(
    r"\b(customer|customers|supplier|suppliers|supply|purchase|purchases|revenue|revenues|net sales|sales|agreement|"
    r"contract|partner|partnership|collaborat\w*|depend\w*|rel(?:y|ies|iance)|accounted|manufactur\w*|foundry|licen[cs]\w*|"
    r"invest\w*|capacity|compute|cloud)\b",
    re.IGNORECASE,
)
# Mentions that aren't about the commercial relationship: biographies, competitor lists, takeover law.
_NOISE = re.compile(
    r"\b(held (?:a variety of )?positions|served as|serves as|board of directors|chief (?:executive|financial|operating) officer|"
    r"prior to joining|compet\w*|change (?:in|of) control|anti-?takeover|certificate of incorporation|rights? of (?:first )?refusal)\b",
    re.IGNORECASE,
)
_PAGE_ARTIFACT = re.compile(r"\s*\d*\s*Table of Contents\s*", re.IGNORECASE)

_FIGURE = re.compile(
    r"(?:US)?\$\s?\d[\d,]*(?:\.\d+)?\s?(?:billion|million|thousand|bn|m)?\b|\b\d+(?:\.\d+)?\s?(?:%|percent\b)",
    re.IGNORECASE,
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(“\"])")
# Abbreviations that end with a period but don't end the sentence ("Meta Platforms, Inc. (“Meta”) committed …").
_ABBREVIATION = re.compile(r"\b(?:Inc|Ltd|Co|Corp|Cos|Bros|Jr|Sr|Dr|Mr|Ms|Mrs|No|Nos|vs|approx|U\.S|U\.K|S\.A|N\.V|L\.P|L\.L\.C|e\.g|i\.e)\.$")


def split_sentences(text: str) -> list[str]:
    pieces = _SENTENCE_SPLIT.split(text.replace("\n", " "))
    out: list[str] = []
    for piece in pieces:
        if out and _ABBREVIATION.search(out[-1].rstrip()):
            out[-1] = f"{out[-1]} {piece}"
        else:
            out.append(piece)
    return out


class RelationshipNotFoundError(Exception):
    pass


@dataclass(frozen=True)
class FilingNote:
    company: str  # company id
    form: str
    accession: str
    filed: str
    url: str
    excerpts: list[str]  # verbatim sentences naming the partner
    figures: list[str]  # percentages / dollar amounts appearing in those sentences
    fingerprint: str
    as_of: str  # when this content was first recorded
    updated_from: str | None = None  # accession of the filing whose content this replaced
    checked_accession: str | None = None  # latest filing examined (may be newer than `accession`)
    latest_names_partner: bool = True  # False when only an earlier report names the partner


@dataclass(frozen=True)
class SideContext:
    company: str
    name: str
    public: bool
    has_filings: bool
    note: FilingNote | None = None
    status: str = ""  # human-readable reason when there's no note


@dataclass(frozen=True)
class RelationshipContext:
    supplier: SideContext
    client: SideContext
    product: str | None
    major: bool
    revenue_pct: float | None
    source_note: str | None
    summary: str  # one plain sentence from the curated data; filing excerpts carry the substance
    notes_updated: list[str] = field(default_factory=list)


def find_mentions(text: str, names: list[str]) -> list[str]:
    """Sentences naming the partner (case-sensitive whole words), relationship-related ones first."""
    pattern = re.compile(r"(?<![\w&])(?:" + "|".join(re.escape(n) for n in names if n) + r")(?![\w&])")
    seen: set[str] = set()
    hits: list[tuple[int, int, str]] = []
    for i, raw in enumerate(split_sentences(text)):
        sentence = re.sub(r"\s+", " ", _PAGE_ARTIFACT.sub(" ", raw)).strip()
        if not (30 <= len(sentence) <= MAX_SENTENCE_CHARS) or not pattern.search(sentence):
            continue
        # Must be about the relationship (and not a bio, competitor list, glossary line or legal boilerplate).
        if not _RELATIONSHIP_WORDS.search(sentence) or _NOISE.search(sentence) or len(sentence.split()) < 8:
            continue
        key = sentence.lower()
        if key in seen:
            continue
        seen.add(key)
        # Disclosed figures and more relationship vocabulary rank first.
        hits.append((-(len(_RELATIONSHIP_WORDS.findall(sentence)) + 2 * bool(_FIGURE.search(sentence))), i, sentence))
    # Filings often restate the same disclosure (e.g. in Business and again in the notes): keep one per set of figures.
    best: list[tuple[int, int, str]] = []
    figure_sets: set[tuple[str, ...]] = set()
    for hit in sorted(hits):
        figs = tuple(m.group(0).strip() for m in _FIGURE.finditer(hit[2]))
        if figs and figs in figure_sets:
            continue
        figure_sets.add(figs)
        best.append(hit)
        if len(best) == MAX_EXCERPTS:
            break
    return [s for _, _, s in sorted(best, key=lambda h: h[1])]  # back in document order


def figures_in(sentences: list[str]) -> list[str]:
    out: list[str] = []
    for s in sentences:
        for m in _FIGURE.finditer(s):
            f = m.group(0).strip()
            if f not in out:
                out.append(f)
    return out


def fingerprint(excerpts: list[str]) -> str:
    return hashlib.sha256("\n".join(excerpts).encode()).hexdigest()[:16]


def annual_reports(submissions: dict[str, Any], cik: int, limit: int = LOOKBACK_REPORTS) -> list[dict[str, str]]:
    """Newest-first 10-K / 20-F / 40-F filings (amendments excluded)."""
    recent = submissions.get("filings", {}).get("recent", {})
    out: list[dict[str, str]] = []
    for i, form in enumerate(recent.get("form", [])):
        if form in ANNUAL_FORMS:
            accession = recent["accessionNumber"][i]
            out.append({
                "form": form,
                "accession": accession,
                "filed": recent["filingDate"][i],
                "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{recent['primaryDocument'][i]}",
            })  # fmt: skip
            if len(out) >= limit:
                break
    return out


def latest_annual(submissions: dict[str, Any], cik: int) -> dict[str, str] | None:
    reports = annual_reports(submissions, cik, 1)
    return reports[0] if reports else None


class NoteStore:
    """data/relationship_notes.json: {"SUPPLIER>CLIENT": {"SUPPLIER": FilingNote, "CLIENT": FilingNote}}."""

    def __init__(self, path: Path = NOTES_PATH):
        self.path = path
        self._lock = threading.Lock()

    def read(self) -> dict[str, dict[str, dict[str, Any]]]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def put(self, key: str, side: str, note: FilingNote) -> None:
        with self._lock:
            data = self.read()
            data.setdefault(key, {})[side] = asdict(note)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8")
            tmp.replace(self.path)


def reconcile(
    stored: FilingNote | None, filing: dict[str, str], excerpts: list[str], now: str, latest: str | None = None
) -> tuple[FilingNote, bool]:
    """(note to keep, whether its content changed). Same content → stored note untouched except the checked filing.

    `filing` is the report quoted; `latest` the newest report examined (defaults to `filing`).
    """
    latest = latest or filing["accession"]
    fp = fingerprint(excerpts)
    if stored is not None and stored.fingerprint == fp:
        return FilingNote(**{**asdict(stored), "checked_accession": latest}), False
    return (
        FilingNote(
            company=stored.company if stored else "",
            form=filing["form"],
            accession=filing["accession"],
            filed=filing["filed"],
            url=filing["url"],
            excerpts=excerpts,
            figures=figures_in(excerpts),
            fingerprint=fp,
            as_of=now,
            updated_from=stored.accession if stored else None,
            checked_accession=latest,
            latest_names_partner=filing["accession"] == latest or not excerpts,
        ),
        True,
    )


class RelationshipNotes:
    def __init__(self, sec: SecEdgarClient, router: DataRouter, chain: SupplyChainStore, store: NoteStore | None = None, filed: Any = None):
        self.sec = sec
        self.router = router
        self.chain = chain
        self.store = store or NoteStore()
        self.filed = filed  # FiledRelationships: names for companies outside the curated file
        self._locks: dict[str, asyncio.Lock] = {}

    async def context(self, supplier: str, client: str) -> RelationshipContext:
        data = self.chain._load()
        companies: dict[str, Any] = dict(data.get("companies", {}))
        s_id, c_id = supplier.strip().upper(), client.strip().upper()
        # Companies outside the curated file (links read from a filing): any SEC registrant.
        if self.filed is not None and (s_id not in companies or c_id not in companies):
            index = await self.filed.index(data.get("companies", {}))
            for cid in (s_id, c_id):
                if cid not in companies and (e := index.by_id.get(cid)):
                    companies[cid] = {"name": e.name, "public": e.public, "mentions": [e.name]}
        if s_id not in companies or c_id not in companies:
            raise RelationshipNotFoundError(f"Unknown company in {s_id} → {c_id}")
        link = next((r for r in data.get("relationships", []) if r.get("supplier") == s_id and r.get("client") == c_id), {})

        key = f"{s_id}>{c_id}"
        lock = self._locks.setdefault(key, asyncio.Lock())  # one refresh per relationship at a time
        async with lock:
            updated: list[str] = []
            sides = []
            for me, partner in ((s_id, c_id), (c_id, s_id)):
                side, changed = await self._side(key, me, companies[me], companies[partner])
                sides.append(side)
                if changed:
                    updated.append(me)

        s_name, c_name = companies[s_id]["name"], companies[c_id]["name"]
        product = link.get("product")
        summary = (
            f"{s_name} supplies {c_name} with {product}."
            if product
            else f"{s_name} supplies {c_name}." if link else f"{s_name} is named as a supplier of {c_name} in SEC filings."
        )
        return RelationshipContext(
            supplier=sides[0],
            client=sides[1],
            product=product,
            major=bool(link.get("major")),
            revenue_pct=link.get("revenue_pct"),
            source_note=link.get("source"),
            summary=summary,
            notes_updated=updated,
        )

    async def _side(self, key: str, cid: str, company: dict[str, Any], partner: dict[str, Any]) -> tuple[SideContext, bool]:
        name, public = company["name"], bool(company.get("public"))
        if not public:
            return SideContext(cid, name, public, False, status="Private company — no public filings"), False
        try:
            route = await self.router.resolve(cid)
        except SecApiError:
            return SideContext(cid, name, public, False, status="Not found on SEC EDGAR"), False
        if route.source is not DataSource.SEC or route.cik is None:
            return SideContext(cid, name, public, False, status="Not an SEC filer — its annual reports aren't on EDGAR"), False

        stored_raw = self.store.read().get(key, {}).get(cid)
        stored = FilingNote(**stored_raw) if stored_raw else None
        try:
            reports = annual_reports(await self.sec.get_submissions(route.cik), route.cik)
        except SecApiError as exc:
            # SEC unreachable (or throttling): serve what we have rather than nothing.
            if stored:
                return SideContext(cid, name, public, True, stored, status="Showing the last saved note (SEC unavailable)"), False
            return SideContext(cid, name, public, True, status=f"SEC unavailable: {exc}"), False
        if not reports:
            return SideContext(cid, name, public, True, status="No 10-K, 20-F or 40-F on file"), False
        latest = reports[0]
        if stored and latest["accession"] in (stored.accession, stored.checked_accession):
            return SideContext(cid, name, public, True, stored), False  # already read this filing

        # A new annual report: read it, and only if it doesn't name the partner, look back further.
        names = partner.get("mentions") or [partner["name"]]
        quoted, excerpts = latest, []
        for report in reports:
            try:
                text = html_to_text(await self.sec.get_filing_document(report["url"]))
            except SecApiError as exc:
                if stored:
                    return SideContext(cid, name, public, True, stored, status="Showing the last saved note (filing unavailable)"), False
                return SideContext(cid, name, public, True, status=f"Filing unavailable: {exc}"), False
            excerpts = find_mentions(text, names)
            if excerpts:
                quoted = report
                break
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        note, changed = reconcile(stored, quoted, excerpts, now, latest["accession"])
        note = FilingNote(**{**asdict(note), "company": cid})
        self.store.put(key, cid, note)
        return SideContext(cid, name, public, True, note), changed and stored is not None
