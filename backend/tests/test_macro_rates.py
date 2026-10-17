import json
from datetime import date

import httpx
import pytest

from app.core.config import Settings
from app.services import macro_rates
from app.services.macro_rates import (
    DEFAULT_FACTORS,
    FRED_SOURCE,
    TREASURY_SOURCE,
    MacroFactorsError,
    YieldObservation,
    latest_observation,
    load_macro_factors,
    parse_fred_api,
    parse_fred_csv,
    parse_treasury_csv,
    save_macro_factors,
    sync_live_market_factors,
)
from app.services.peers import PEER_GROUPS

def _stale_cache(path):
    """A cache whose rate predates every fixture observation, so any fetched print is newer."""
    from dataclasses import replace

    old = replace(DEFAULT_FACTORS, risk_free_rate=replace(DEFAULT_FACTORS.risk_free_rate, as_of="2026-09-30"))
    save_macro_factors(old, path)
    return path


TREASURY_OCT = """Date,"1 Mo","3 Mo","2 Yr","5 Yr","10 Yr","30 Yr"
10/15/2026,4.17,4.28,4.77,4.91,5.10,5.43
10/14/2026,4.11,4.28,4.82,5.00,5.19,5.52
"""
FRED_CSV = """observation_date,DGS10
2026-10-09,5.24
2026-10-12,
2026-10-13,5.21
2026-10-14,5.19
"""


def test_parsers_take_the_latest_published_value():
    assert parse_treasury_csv(TREASURY_OCT) == YieldObservation(date(2026, 10, 15), 5.10, TREASURY_SOURCE)
    assert parse_fred_csv(FRED_CSV) == YieldObservation(date(2026, 10, 14), 5.19, FRED_SOURCE)  # blank holiday skipped
    api = {"observations": [{"date": "2026-10-15", "value": "."}, {"date": "2026-10-14", "value": "5.19"}]}
    assert parse_fred_api(api) == YieldObservation(date(2026, 10, 14), 5.19, FRED_SOURCE)
    assert parse_treasury_csv("Date,10 Yr\n") is None


def test_newest_observation_wins_and_treasury_breaks_ties():
    t = YieldObservation(date(2026, 10, 15), 5.10, TREASURY_SOURCE)
    f = YieldObservation(date(2026, 10, 14), 5.19, FRED_SOURCE)
    assert latest_observation(t, f) is t
    assert latest_observation(None, f) is f
    assert latest_observation(YieldObservation(date(2026, 10, 15), 5.11, FRED_SOURCE), t) is t
    assert latest_observation(None, None) is None


def _client(treasury=TREASURY_OCT, fred=FRED_CSV, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if request.url.host == "home.treasury.gov":
            month = request.url.params["field_tdr_date_value_month"]
            return httpx.Response(200, text=treasury if month == "202610" else 'Date,"10 Yr"\n') if treasury else httpx.Response(503)
        return httpx.Response(200, text=fred) if fred else httpx.Response(500)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_sync_writes_the_latest_yield_and_keeps_other_factors(tmp_path):
    path = tmp_path / "macro.json"
    async with _client() as client:
        factors = await sync_live_market_factors(path, settings=Settings(_env_file=None), client=client, today=date(2026, 10, 16))
    assert (factors.risk_free_rate.value, factors.risk_free_rate.as_of, factors.risk_free_rate.source) == (0.051, "2026-10-15", TREASURY_SOURCE)
    on_disk = json.loads(path.read_text())
    assert on_disk["risk_free_rate"]["value"] == 0.051
    assert on_disk["equity_risk_premium"] == {"value": 0.0446, "as_of": "2026-01-05", "source": DEFAULT_FACTORS.equity_risk_premium.source}
    assert set(on_disk["sector_betas"]) == set(PEER_GROUPS) | {"market"}


async def test_sync_falls_back_to_fred_and_uses_the_api_with_a_key(tmp_path):
    seen = []
    api_payload = json.dumps({"observations": [{"date": "2026-10-14", "value": "5.19"}]})
    async with _client(treasury=None, fred=api_payload, seen=seen) as client:
        settings = Settings(_env_file=None, FRED_API_KEY="k")
        factors = await sync_live_market_factors(_stale_cache(tmp_path / "m.json"), settings=settings, client=client, today=date(2026, 10, 16))
    assert (factors.risk_free_rate.value, factors.risk_free_rate.source) == (0.0519, FRED_SOURCE)
    assert any(r.url.host == "api.stlouisfed.org" and r.url.params["api_key"] == "k" for r in seen)


async def test_first_of_month_reads_the_previous_months_file(tmp_path):
    seen = []
    async with _client(seen=seen) as client:
        await sync_live_market_factors(tmp_path / "m.json", settings=Settings(_env_file=None), client=client, today=date(2026, 11, 1))
    months = {r.url.params["field_tdr_date_value_month"] for r in seen if r.url.host == "home.treasury.gov"}
    assert months == {"202611", "202610"}


async def test_failed_sync_leaves_the_file_untouched_and_still_collects(tmp_path, monkeypatch):
    path = tmp_path / "m.json"
    save_macro_factors(DEFAULT_FACTORS, path)
    before = path.read_text()
    collected = []
    monkeypatch.setattr(macro_rates.gc, "collect", lambda *a: collected.append(True) or 0)
    async with _client(treasury=None, fred=None) as client:
        with pytest.raises(MacroFactorsError):
            await sync_live_market_factors(path, settings=Settings(_env_file=None), client=client, today=date(2026, 10, 16))
    assert path.read_text() == before
    assert collected == [True]


async def test_sync_runs_a_garbage_collection_pass(tmp_path, monkeypatch):
    collected = []
    monkeypatch.setattr(macro_rates.gc, "collect", lambda *a: collected.append(True) or 0)
    async with _client() as client:
        await sync_live_market_factors(tmp_path / "m.json", settings=Settings(_env_file=None), client=client, today=date(2026, 10, 16))
    assert collected == [True]


def test_load_creates_defaults_round_trips_and_survives_corruption(tmp_path):
    path = tmp_path / "nested" / "macro.json"
    assert load_macro_factors(path) == DEFAULT_FACTORS and path.exists()
    assert load_macro_factors(path) == DEFAULT_FACTORS  # parsed back from disk
    path.write_text("{ not json")
    assert load_macro_factors(path) == DEFAULT_FACTORS
    assert path.read_text() == "{ not json"  # hand edits are never overwritten
    assert not list(path.parent.glob(".macro_factors.*"))  # no temp files left behind


def test_capm_and_beta_lookup():
    f = DEFAULT_FACTORS
    assert f.beta_for("utilities").beta == 0.42
    assert f.beta_for("unknown") is f.sector_betas["market"]
    assert f.cost_of_equity("semiconductors") == pytest.approx(0.0510 + 1.52 * 0.0446)
    assert set(f.sector_betas) == set(PEER_GROUPS) | {"market"}  # every peer group has a baseline beta


def test_importing_the_module_does_not_sync(tmp_path):
    """Only `python -m app.services.macro_rates` syncs: importing it (as the app does) touches nothing."""
    import os
    import subprocess
    import sys

    path = tmp_path / "macro.json"
    env = {**os.environ, "IS_MACRO_FACTORS_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import app.services.macro_rates"], check=True, env=env, cwd=os.getcwd())
    assert not path.exists()


async def test_a_slow_source_is_skipped_within_the_time_budget(tmp_path):
    import asyncio
    import time

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "home.treasury.gov":
            await asyncio.sleep(5)  # Treasury having a slow day
            return httpx.Response(200, text=TREASURY_OCT)
        return httpx.Response(200, text=FRED_CSV)

    settings = Settings(_env_file=None, macro_sync_source_timeout_seconds=0.2)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        started = time.perf_counter()
        factors = await sync_live_market_factors(_stale_cache(tmp_path / "m.json"), settings=settings, client=client, today=date(2026, 10, 16))
    assert time.perf_counter() - started < 1.5
    assert (factors.risk_free_rate.value, factors.risk_free_rate.source) == (0.0519, FRED_SOURCE)


async def test_sync_never_replaces_a_newer_rate_with_an_older_one(tmp_path):
    path = tmp_path / "m.json"
    async with _client() as client:  # Treasury 10/15 at 5.10%
        await sync_live_market_factors(path, settings=Settings(_env_file=None), client=client, today=date(2026, 10, 16))
    async with _client(treasury=None) as client:  # Treasury down: only FRED's 10/14 print is reachable
        factors = await sync_live_market_factors(path, settings=Settings(_env_file=None), client=client, today=date(2026, 10, 16))
    assert (factors.risk_free_rate.value, factors.risk_free_rate.as_of) == (0.051, "2026-10-15")
    assert json.loads(path.read_text())["risk_free_rate"]["as_of"] == "2026-10-15"
