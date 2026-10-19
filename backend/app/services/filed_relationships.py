"""Supplier / customer links read from a company's own annual report, for any SEC filer.

The curated web (data/supply_chain.json) covers widely followed companies. For everyone else — and
to add what the curated file lacks — the focus company's latest 10-K / 20-F / 40-F is scanned:

  1. keep sentences about commercial relationships (customer, supplier, sole source, foundry, …),
     dropping biographies, competitor lists and legal boilerplate (same rules as the relationship card);
  2. find company names in them: the curated companies' known names plus every SEC registrant
     (EDGAR's company list, titles cleaned: "MICRON TECHNOLOGY INC" → "Micron Technology");
  3. decide the direction from the words around each name: "customer", "sales to" → the partner is a
     client; "supplier", "sole source", "manufactured by" → a supplier. Ambiguous mentions are dropped.

Every derived link carries the sentence it came from. Results are stored per filing (accession) in
data/filed_relationships.json, so each annual report is downloaded and parsed once.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.services.data_router import DataRouter, DataSource
from app.services.mdna import html_to_text
from app.services.relationship_notes import _NOISE, _PAGE_ARTIFACT, _RELATIONSHIP_WORDS, annual_reports, split_sentences
from app.services.sec_client import SecApiError, SecEdgarClient

STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "filed_relationships.json"
MAX_PARTNERS = 20
WINDOW = 140  # characters either side of a name used to read the direction

_CLIENT_WORDS = re.compile(
    r"\b(customers?|sales to|sold to|sells to|revenues? from|net sales to|end customers?|top customers?|largest customers?|"
    r"purchased (?:from us|our)|buys? our|distributors?|OEMs?)\b",
    re.IGNORECASE,
)
_SUPPLIER_WORDS = re.compile(
    r"\b(suppliers?|sole[- ]source|single[- ]source|sole supplier|purchases? (?:from|of)|purchased from|manufactured by|"
    r"foundry|foundries|contract manufacturers?|vendors?|license[sd]? from|supplied by|provided by|depend(?:s|ent)? on)\b",
    re.IGNORECASE,
)
_SUFFIXES = {
    "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "LLC", "LP", "L P",
    "NV", "N V", "SA", "S A", "AG", "SE", "HOLDINGS", "HOLDING", "GROUP", "COM", "TRUST", "THE", "DE", "NEW",
}  # fmt: skip
# Single-word names that are ordinary words in filings ("our target customers", "Visa and Mastercard" is fine
# multi-word, but "Block" alone is not a company here).
_COMMON_WORDS = {
    "Target", "Block", "Visa", "Match", "Snap", "Gap", "Box", "Square", "Global", "General", "American", "United",
    "National", "International", "First", "Federal", "Pacific", "Atlantic", "Energy", "Digital", "Data", "Cloud",
    "Alpha", "Omega", "Delta", "Summit", "Pioneer", "Liberty", "Frontier", "Progressive", "Insight", "Vision", "Unity",
    "Fortune", "Paramount", "Compass", "Equity", "Capital", "Western", "Eastern", "Southern", "Northern", "Central",
    "Republic", "Heritage", "Premier", "Select", "Edge", "Core", "Prime", "Apex", "Nova", "Sterling", "Advance",
    "Crown", "Eagle", "Harbor", "Legacy", "Matrix", "Company", "Securities", "Services", "Solutions", "Systems",
    "Technologies", "Technology", "Holdings", "Partners", "Financial", "Bank", "America", "Common",
    "Amazon Com", "United States", "New York", "Health", "Medical", "Pharmaceuticals", "Therapeutics", "Bio",
    "People", "Here", "Innovate", "Social", "Market", "Markets", "Customers", "Products", "Design", "Impact",
    "Spectrum", "Element", "Evolution", "Genesis", "Catalyst", "Precision", "Momentum", "Velocity", "Quantum",
    "Fusion", "Signal", "Pulse", "Nexus", "Vertex", "Intelligence", "Network", "Networks", "Platform", "Power",
    "Energy Transfer", "Ultra", "Future", "Vital", "Clear", "Bright", "Smart", "Open", "Simple", "Rapid", "Sun",
    "Star", "Stellar", "Orbit", "Atlas", "Titan", "Phoenix", "Aspen", "Harmony", "Beacon", "Anchor", "Bridge",
    "Cardinal", "Granite", "Keystone", "Landmark", "Meridian", "Monarch", "Navigator", "Northwest", "Oak",
    "Patriot", "Pinnacle", "Sentinel", "Sierra", "Vanguard", "Venture", "Victory", "Zenith", "Our", "We",
}  # fmt: skip
# Stock exchanges and market venues are named in every annual report ("traded on Nasdaq"), never as partners.
_NOT_PARTNERS = {"NDAQ", "ICE", "CBOE", "NYSE", "LSEG.L", "DB1.DE"}
# Mergers, awards and investments name companies without a supply relationship.
# One-word names from EDGAR's list ("Strategy", "Reliability") are ordinary words too often; outside the
# curated companies they count only when the filing writes them as a company: "Fabrinet Inc.", "Wistron Corporation".
_CORPORATE_SUFFIX = re.compile(r"^,?\s+(?:Inc\b|Incorporated|Corp\b|Corporation|Co\.|Company|Ltd|Limited|LLC|L\.L\.C\.|plc|PLC|N\.V\.|S\.A\.|AG\b|SE\b|GmbH|Holdings)")
_NOT_SUPPLY = re.compile(r"\b(mergers?|merger agreement|acquisition of|to acquire|award(?:s|ed)?|honou?red)\b", re.IGNORECASE)


@dataclass(frozen=True)
class FiledLink:
    partner: str  # company id: curated id, else SEC ticker
    name: str
    public: bool
    ticker: str | None
    direction: str  # "supplier" (partner supplies the focus) | "client" (partner buys from the focus)
    evidence: str  # the sentence it was read from


def clean_title(title: str) -> str | None:
    """EDGAR title → the name a filing would use. None for shells and unusable titles."""
    t = title.split("/")[0].replace(",", " ").replace(".", " ").strip()
    if re.search(r"\b(acquisition|merger|spac|blank check|capital corp|fund|etf|trust)\b", t, re.IGNORECASE):
        return None
    words = t.split()
    while words and words[-1].upper() in _SUFFIXES:
        words.pop()
    while len(words) > 1 and " ".join(words[-2:]).upper() in _SUFFIXES:
        words = words[:-2]
    if not words:
        return None
    if t.isupper() or all(w.isupper() for w in words):
        words = [w if (len(w) <= 3 and w.isalpha()) or "&" in w else w.capitalize() for w in words]
    name = " ".join(words)
    if len(words) == 1 and (len(name) < 4 or name in _COMMON_WORDS):
        return None
    return None if name in _COMMON_WORDS else name


@dataclass(frozen=True)
class Entity:
    id: str
    name: str
    public: bool
    ticker: str | None


class NameIndex:
    """Maps names as they appear in filings to companies. Curated companies win over EDGAR titles."""

    def __init__(self, curated: dict[str, Any], ticker_map: dict[str, dict[str, Any]]):
        self.by_name: dict[str, Entity] = {}
        seen_cik: set[int] = set()
        for ticker, row in ticker_map.items():
            if row["cik"] in seen_cik:  # several share classes per company: keep the first ticker
                continue
            seen_cik.add(row["cik"])
            name = clean_title(row["title"])
            if name and name not in self.by_name:
                self.by_name[name] = Entity(ticker, name, True, ticker)
        for cid, c in curated.items():
            entity = Entity(cid, c["name"], bool(c.get("public")), cid if c.get("public") else None)
            for n in c.get("mentions") or [c["name"]]:
                if n not in _COMMON_WORDS:
                    self.by_name[n] = entity
        self.max_words = max((len(n.split()) for n in self.by_name), default=1)
        self.by_id: dict[str, Entity] = {e.id: e for e in self.by_name.values()}
        self._curated_ids = set(curated)

    def curated(self, cid: str) -> bool:
        return cid in self._curated_ids

    def find(self, sentence: str) -> list[tuple[Entity, int, int]]:
        """Companies named in a sentence (longest name wins): (entity, offset, length of the matched text)."""
        out: list[tuple[Entity, int, int]] = []
        for m in re.finditer(r"[A-Z][\w&'-]*(?:[ ][A-Z&][\w&'-]*)*", sentence):
            words = m.group(0).split(" ")
            offset = m.start()
            i = 0
            while i < len(words):
                for n in range(min(self.max_words, len(words) - i), 0, -1):
                    phrase = " ".join(words[i : i + n])
                    bare = phrase[:-2] if phrase.endswith(("'s", "’s")) else phrase  # possessive: "Apple's"
                    entity = self.by_name.get(phrase) or self.by_name.get(bare)
                    if entity:
                        out.append((entity, offset + len(" ".join(words[:i])) + (1 if i else 0), len(phrase)))
                        i += n
                        break
                else:
                    i += 1
        return out


# A name followed by one of its products ("NVIDIA GB200 systems", "AMD and Intel chips") is a supplier.
_PRODUCT_AFTER = re.compile(
    r"^[\w&'’.\- ]{0,40}?\b(chips?|GPUs?|CPUs?|processors?|accelerators?|systems|servers|hardware|semiconductors?|"
    r"memory|wafers?|components|modules|software|platforms?)\b"
)


def direction_of(sentence: str, at: int, name_len: int = 0) -> str | None:
    """'client' / 'supplier' from the words around a name; None when unclear.

    The nearest relationship word wins (a sentence can mention both customers and suppliers).
    """
    if _PRODUCT_AFTER.match(sentence[at + name_len : at + name_len + 60]):
        return "supplier"
    start = max(0, at - WINDOW)
    window = sentence[start : at + WINDOW]
    centre = at - start

    def nearest(pattern: re.Pattern[str]) -> int | None:
        distances = [min(abs(m.start() - centre), abs(m.end() - centre)) for m in pattern.finditer(window)]
        return min(distances) if distances else None

    c, s = nearest(_CLIENT_WORDS), nearest(_SUPPLIER_WORDS)
    if c is None and s is None:
        return None
    if s is None or (c is not None and c < s):
        return "client"
    if c is None or s < c:
        return "supplier"
    return None


def extract_links(text: str, index: NameIndex, self_ids: set[str]) -> list[FiledLink]:
    links: dict[tuple[str, str], FiledLink] = {}
    counts: dict[tuple[str, str], int] = {}
    for raw in split_sentences(text):
        sentence = re.sub(r"\s+", " ", _PAGE_ARTIFACT.sub(" ", raw)).strip()
        if not (30 <= len(sentence) <= 600) or not _RELATIONSHIP_WORDS.search(sentence) or _NOISE.search(sentence):
            continue
        if _NOT_SUPPLY.search(sentence):
            continue
        for entity, at, length in index.find(sentence):
            if entity.id in self_ids or entity.id in _NOT_PARTNERS:
                continue
            if not index.curated(entity.id) and " " not in sentence[at : at + length].strip():
                if not _CORPORATE_SUFFIX.match(sentence[at + length : at + length + 20]):
                    continue
            direction = direction_of(sentence, at, length)
            if direction is None:
                continue
            key = (entity.id, direction)
            counts[key] = counts.get(key, 0) + 1
            links.setdefault(key, FiledLink(entity.id, entity.name, entity.public, entity.ticker, direction, sentence))
    ranked = sorted(links, key=lambda k: -counts[k])[:MAX_PARTNERS]
    return [links[k] for k in ranked]


class FiledStore:
    """data/filed_relationships.json: {focus id: {"accession", "form", "filed", "url", "links": [FiledLink]}}."""

    def __init__(self, path: Path = STORE_PATH):
        self.path = path
        self._lock = threading.Lock()

    def get(self, focus: str) -> dict[str, Any] | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8")).get(focus)
        except (OSError, ValueError):
            return None

    def put(self, focus: str, record: dict[str, Any]) -> None:
        with self._lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            data[focus] = record
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8")
            tmp.replace(self.path)


@dataclass(frozen=True)
class FiledResult:
    links: list[FiledLink]
    form: str | None = None
    filed: str | None = None
    url: str | None = None
    status: str = ""


class FiledRelationships:
    def __init__(self, sec: SecEdgarClient, router: DataRouter, store: FiledStore | None = None):
        self.sec = sec
        self.router = router
        self.store = store or FiledStore()
        self._index: tuple[int, NameIndex] | None = None

    async def index(self, curated: dict[str, Any]) -> NameIndex:
        ticker_map = await self.sec.get_ticker_map()
        key = id(ticker_map) ^ len(curated)
        if self._index is None or self._index[0] != key:
            self._index = (key, NameIndex(curated, ticker_map))
        return self._index[1]

    async def links_for(self, focus: str, symbol: str, curated: dict[str, Any], self_names: list[str]) -> FiledResult:
        """Links named in the focus company's latest annual report (read once per filing)."""
        try:
            route = await self.router.resolve(symbol)
        except SecApiError:
            return FiledResult([], status="Not found on SEC EDGAR")
        if route.source is not DataSource.SEC or route.cik is None:
            return FiledResult([], status="Not an SEC filer, so there's no annual report to read")
        try:
            reports = annual_reports(await self.sec.get_submissions(route.cik), route.cik, 1)
        except SecApiError as exc:
            stored = self.store.get(focus)
            if stored:
                return FiledResult([FiledLink(**l) for l in stored["links"]], stored["form"], stored["filed"], stored["url"], "SEC unavailable — showing the last reading")
            return FiledResult([], status=f"SEC unavailable: {exc}")
        if not reports:
            return FiledResult([], status="No 10-K, 20-F or 40-F on file")
        latest = reports[0]
        stored = self.store.get(focus)
        if stored and stored.get("accession") == latest["accession"]:
            return FiledResult([FiledLink(**l) for l in stored["links"]], stored["form"], stored["filed"], stored["url"])
        try:
            text = html_to_text(await self.sec.get_filing_document(latest["url"]))
        except SecApiError as exc:
            return FiledResult([], status=f"Filing unavailable: {exc}")
        index = await self.index(curated)
        self_ids = {focus, symbol.upper()} | {e.id for n in self_names if (e := index.by_name.get(n))}
        links = extract_links(text, index, self_ids)
        self.store.put(focus, {**latest, "links": [asdict(l) for l in links]})
        return FiledResult(links, latest["form"], latest["filed"], latest["url"])
