"""Supply-chain graph building and live reload of the data file."""

import json
import os

from app.services.supply_chain import DATA_PATH, SupplyChainStore


def write(path, companies, relationships):
    path.write_text(json.dumps({"companies": companies, "relationships": relationships}))


COMPANIES = {
    "AAPL": {"name": "Apple", "public": True},
    "TSM": {"name": "TSMC", "public": True, "aliases": ["2330.TW"]},
    "NVDA": {"name": "NVIDIA", "public": True},
    "VZ": {"name": "Verizon", "public": True},
    "ZEISS": {"name": "Carl Zeiss SMT", "public": False},
}
LINKS = [
    {"supplier": "TSM", "client": "AAPL", "product": "chips", "major": True},
    {"supplier": "AAPL", "client": "VZ", "revenue_pct": 5.5},
    {"supplier": "TSM", "client": "NVDA"},  # outside AAPL's neighbourhood
    {"supplier": "ZEISS", "client": "TSM"},
]


def test_graph_has_focus_suppliers_clients_and_peer_links(tmp_path):
    path = tmp_path / "sc.json"
    write(path, COMPANIES, LINKS)
    g = SupplyChainStore(path).graph("aapl")
    roles = {n.id: n.role for n in g.nodes}
    assert roles == {"AAPL": "focus", "TSM": "supplier", "VZ": "client"}
    types = {(e.source, e.target): e.type for e in g.edges}
    assert types == {("TSM", "AAPL"): "supplier", ("AAPL", "VZ"): "client"}
    assert next(e for e in g.edges if e.target == "VZ").revenue_pct == 5.5


def test_aliases_private_nodes_and_unknown_companies(tmp_path):
    path = tmp_path / "sc.json"
    write(path, COMPANIES, LINKS)
    store = SupplyChainStore(path)
    g = store.graph("2330.TW")
    assert g.focus == "TSM"
    zeiss = next(n for n in g.nodes if n.id == "ZEISS")
    assert not zeiss.public and zeiss.ticker is None
    unknown = store.graph("XYZ")
    assert unknown.nodes == [] and ("AAPL", "Apple") in unknown.covered


def test_edits_to_the_file_show_up_without_a_restart(tmp_path):
    path = tmp_path / "sc.json"
    write(path, COMPANIES, LINKS)
    store = SupplyChainStore(path)
    assert len(store.graph("AAPL").nodes) == 3
    write(path, COMPANIES, [*LINKS, {"supplier": "NVDA", "client": "AAPL"}])
    os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 5))
    assert len(store.graph("AAPL").nodes) == 4


def test_shipped_data_file_is_consistent():
    data = json.loads(DATA_PATH.read_text())
    companies = data["companies"]
    for r in data["relationships"]:
        assert r["supplier"] in companies and r["client"] in companies, r
        assert r["supplier"] != r["client"], r
        if r.get("revenue_pct") is not None:
            assert 0 < r["revenue_pct"] <= 100 and r.get("source"), r  # disclosed figures must cite the filing
