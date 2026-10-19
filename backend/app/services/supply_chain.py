"""Supply Chain Network: supplier → client relationships around a company, as a graph.

Relationships live in data/supply_chain.json (curated: no free API publishes company-to-company supply
links, and SEC filings name major customers only in prose). The file is re-read whenever its
modification time changes, so edits show up on the next request without a restart.

Graph for a focus company: the company, its direct suppliers and clients, and every link among those
nodes (so shared suppliers show as a web). Edges are directed supplier → client.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "supply_chain.json"


class SupplyChainError(Exception):
    pass


@dataclass(frozen=True)
class Node:
    id: str
    name: str
    public: bool
    ticker: str | None  # loadable symbol for public companies, None for private ones
    role: str  # "focus" | "supplier" | "client" | "both"
    mentions: list[str] = field(default_factory=list)  # names used for it in other companies' filings


@dataclass(frozen=True)
class Edge:
    source: str  # supplier
    target: str  # client
    type: str  # "supplier" (into the focus company) | "client" (out of it) | "peer" (between partners)
    product: str | None = None
    revenue_pct: float | None = None  # client's share of the supplier's revenue, when disclosed
    major: bool = False  # disclosed ≥10% customer
    source_note: str | None = None
    origin: str = "curated"  # "curated" (data/supply_chain.json) | "filing" (read from the focus company's annual report)
    evidence: str | None = None  # the filing sentence a "filing" link was read from


@dataclass(frozen=True)
class SupplyChainGraph:
    focus: str
    nodes: list[Node]
    edges: list[Edge]
    covered: list[tuple[str, str]] = field(default_factory=list)  # (id, name) of every company with a mapped link
    filing: dict[str, str] | None = None  # the annual report read for this web: form, filed, url
    filing_status: str = ""  # why no report was read, when none was


class SupplyChainStore:
    def __init__(self, path: Path = DATA_PATH):
        self.path = path
        self._lock = threading.Lock()
        self._mtime: float | None = None
        self._data: dict[str, Any] = {}

    def _load(self) -> dict[str, Any]:
        try:
            mtime = self.path.stat().st_mtime
        except OSError as exc:
            raise SupplyChainError(f"Supply-chain data file missing: {self.path.name}") from exc
        with self._lock:
            if mtime != self._mtime:
                try:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    raise SupplyChainError(f"Supply-chain data file is unreadable: {exc}") from exc
                self._data, self._mtime = data, mtime
            return self._data

    def _resolve(self, data: dict[str, Any], identifier: str) -> str | None:
        key = identifier.strip().upper()
        companies: dict[str, Any] = data.get("companies", {})
        if key in companies:
            return key
        return next((k for k, c in companies.items() if key in (a.upper() for a in c.get("aliases", []))), None)

    def graph(self, identifier: str) -> SupplyChainGraph:
        data = self._load()
        companies: dict[str, Any] = data.get("companies", {})
        links: list[dict[str, Any]] = [r for r in data.get("relationships", []) if r.get("supplier") in companies and r.get("client") in companies]
        linked = {r["supplier"] for r in links} | {r["client"] for r in links}
        covered = sorted(((c, companies[c]["name"]) for c in linked), key=lambda t: t[1].lower())
        focus = self._resolve(data, identifier)
        if focus is None or focus not in linked:
            return SupplyChainGraph(identifier.strip().upper(), [], [], covered)

        suppliers = {r["supplier"] for r in links if r["client"] == focus}
        clients = {r["client"] for r in links if r["supplier"] == focus}
        members = {focus} | suppliers | clients

        def role(cid: str) -> str:
            if cid == focus:
                return "focus"
            return "both" if cid in suppliers and cid in clients else "supplier" if cid in suppliers else "client"

        nodes = [
            Node(
                cid,
                companies[cid]["name"],
                bool(companies[cid].get("public")),
                cid if companies[cid].get("public") else None,
                role(cid),
                companies[cid].get("mentions") or [companies[cid]["name"]],
            )
            for cid in sorted(members, key=lambda c: (c != focus, companies[c]["name"]))
        ]
        edges = [
            Edge(
                source=r["supplier"],
                target=r["client"],
                type="supplier" if r["client"] == focus else "client" if r["supplier"] == focus else "peer",
                product=r.get("product"),
                revenue_pct=r.get("revenue_pct"),
                major=bool(r.get("major")),
                source_note=r.get("source"),
            )
            for r in links
            if r["supplier"] in members and r["client"] in members
        ]
        return SupplyChainGraph(focus, nodes, edges, covered)


async def build_graph(store: SupplyChainStore, filed: Any, identifier: str) -> SupplyChainGraph:
    """Curated links plus the links named in the focus company's own latest annual report."""
    data = store._load()
    companies: dict[str, Any] = data.get("companies", {})
    curated = store.graph(identifier)
    focus = store._resolve(data, identifier) or identifier.strip().upper()
    symbol = focus if focus in companies else identifier.strip().upper()
    names = companies.get(focus, {}).get("mentions") or ([companies[focus]["name"]] if focus in companies else [])
    result = await filed.links_for(focus, symbol, companies, names)

    nodes = {n.id: n for n in curated.nodes}
    edges = list(curated.edges)
    if not nodes and (result.links or result.form):
        index = await filed.index(companies)
        entity = index.by_id.get(symbol)
        name = companies.get(focus, {}).get("name") or (entity.name if entity else symbol)
        nodes[focus] = Node(focus, name, True, symbol, "focus", names or [name])
    linked = {(e.source, e.target) for e in edges}
    focus_name = nodes[focus].name if focus in nodes else focus
    for link in result.links:
        pair = (link.partner, focus) if link.direction == "supplier" else (focus, link.partner)
        if pair in linked or link.partner == focus:
            continue
        linked.add(pair)
        existing = nodes.get(link.partner)
        if existing is None:
            mentions = companies.get(link.partner, {}).get("mentions") or [link.name]
            nodes[link.partner] = Node(link.partner, companies.get(link.partner, {}).get("name", link.name), link.public, link.ticker, link.direction, mentions)
        elif existing.role not in ("focus", link.direction):
            nodes[link.partner] = Node(existing.id, existing.name, existing.public, existing.ticker, "both", existing.mentions)
        edges.append(
            Edge(
                source=pair[0],
                target=pair[1],
                type=link.direction,
                source_note=f"Named in {focus_name}'s {result.form} filed {result.filed}",
                origin="filing",
                evidence=link.evidence,
            )
        )
    ordered = sorted(nodes.values(), key=lambda n: (n.role != "focus", n.name.lower()))
    filing = {"form": result.form, "filed": result.filed, "url": result.url} if result.form else None
    return SupplyChainGraph(focus if ordered else identifier.strip().upper(), ordered, edges, curated.covered, filing, result.status)
