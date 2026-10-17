"""Macro valuation factors: risk-free rate, equity risk premium and baseline sector betas.

The active constants live in a local JSON file (`settings.macro_factors_path`, by default
`backend/data/macro_factors.json`) so valuations use one consistent, inspectable set of inputs and
the file can be edited by hand. The cache is event-driven and holds nothing in memory:
`load_macro_factors()` reads the file on each call, and the file changes only when a sync runs.

Refreshing the risk-free rate is always an explicit action — never on import, app startup or a timer:
  - the Intrinsic Valuation Station's "⚡ Sync Live Market Factors" button (POST /api/macro/sync)
  - running this module directly:  cd backend && .venv/bin/python -m app.services.macro_rates

`sync_live_market_factors()` fetches the latest 10-year US Treasury constant-maturity yield from two
free sources and keeps whichever observation is newer:
  - U.S. Treasury "Daily Treasury Par Yield Curve Rates" CSV (the original source; no key)
  - FRED series DGS10 (Federal Reserve Bank of St. Louis): the official API when FRED_API_KEY is
    set, otherwise the keyless fredgraph CSV download. FRED republishes Treasury's figure, usually
    one business day later.

Seed values (update the JSON as new editions are published):
  - Equity risk premium: 4.46% — Aswath Damodaran, "Country Default Spreads and Risk Premiums",
    United States total ERP, updated January 5, 2026.
  - Sector betas: Damodaran, "Betas by Sector (US)", January 2026, mapped onto our peer groups
    (`peers.PEER_GROUPS`); groups spanning several Damodaran industries use firm-count-weighted
    averages. `unlevered_beta` is his unlevered beta corrected for cash.
"""

from __future__ import annotations

import asyncio
import csv
import gc
import io
import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

TREASURY_CSV_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/{month}"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_SERIES = "DGS10"

TREASURY_SOURCE = "U.S. Treasury Daily Par Yield Curve (10 Yr)"
FRED_SOURCE = "FRED DGS10 (10-Year Treasury Constant Maturity)"


# ---------------------------------------------------------------- model


@dataclass(frozen=True)
class RiskFreeRate:
    value: float  # decimal: 0.051 = 5.10%
    as_of: str  # ISO date of the observation
    source: str
    tenor: str = "10Y"


@dataclass(frozen=True)
class EquityRiskPremium:
    value: float  # decimal
    as_of: str
    source: str


@dataclass(frozen=True)
class SectorBeta:
    beta: float  # levered, as observed
    unlevered_beta: float  # Damodaran's unlevered beta corrected for cash
    industries: list[str] = field(default_factory=list)  # source industries averaged


@dataclass(frozen=True)
class MacroFactors:
    risk_free_rate: RiskFreeRate
    equity_risk_premium: EquityRiskPremium
    sector_betas: dict[str, SectorBeta]  # keyed by peers.PEER_GROUPS key, plus "market"
    sector_betas_source: str
    updated_at: str  # ISO timestamp of the last write
    schema_version: int = SCHEMA_VERSION

    def beta_for(self, group: str | None) -> SectorBeta:
        """A peer group's baseline beta, or the total market's when the group is unknown."""
        return self.sector_betas.get(group or "", self.sector_betas["market"])

    def cost_of_equity(self, group: str | None) -> float:
        """CAPM: risk-free rate + levered sector beta × equity risk premium (decimal)."""
        return self.risk_free_rate.value + self.beta_for(group).beta * self.equity_risk_premium.value


def _b(beta: float, unlevered: float, *industries: str) -> SectorBeta:
    return SectorBeta(beta, unlevered, list(industries))


DEFAULT_SECTOR_BETAS: dict[str, SectorBeta] = {
    "big_tech": _b(1.32, 1.28, "Software (System & Application)", "Software (Internet)", "Computers/Peripherals"),
    "software": _b(1.28, 1.25, "Software (System & Application)"),
    "hardware": _b(1.35, 1.32, "Computers/Peripherals"),
    "semiconductors": _b(1.52, 1.50, "Semiconductor"),
    "internet_platforms": _b(1.69, 1.59, "Software (Internet)"),
    "ecommerce": _b(1.30, 1.23, "Retail (General)", "Software (Internet)"),
    "payments": _b(0.97, 0.33, "Financial Svcs. (Non-bank & Insurance)"),
    "banks": _b(0.41, 0.37, "Bank (Money Center)", "Banks (Regional)"),
    "capital_markets": _b(0.71, 0.60, "Brokerage & Investment Banking", "Investments & Asset Management"),
    "managed_care": _b(0.87, 0.74, "Healthcare Support Services"),
    "pharma": _b(1.09, 1.03, "Drugs (Pharmaceutical)", "Drugs (Biotechnology)"),
    "medtech": _b(0.91, 0.86, "Healthcare Products"),
    "life_science_tools": _b(0.91, 0.86, "Healthcare Products"),
    "energy": _b(0.71, 0.57, "Oil/Gas (Integrated)", "Oil/Gas (Production and Exploration)"),
    "oilfield_services": _b(0.95, 0.79, "Oilfield Svcs/Equip."),
    "autos": _b(1.46, 1.31, "Auto & Truck"),
    "aerospace_defense": _b(0.95, 0.87, "Aerospace/Defense"),
    "industrials": _b(1.09, 1.03, "Machinery", "Diversified", "Electrical Equipment"),
    "big_box_retail": _b(0.81, 0.78, "Retail (General)"),
    "home_improvement": _b(1.54, 1.32, "Retail (Building Supply)"),
    "grocery_pharmacy": _b(1.12, 0.85, "Retail (Grocery and Food)"),
    "beverages": _b(0.64, 0.58, "Beverage (Soft)"),
    "packaged_food": _b(0.61, 0.47, "Food Processing"),
    "household_products": _b(0.82, 0.74, "Household Products"),
    "restaurants": _b(0.92, 0.78, "Restaurant/Dining"),
    "apparel": _b(0.96, 0.84, "Apparel", "Shoe"),
    "telecom": _b(0.61, 0.38, "Telecom. Services", "Telecom (Wireless)"),
    "media": _b(0.82, 0.72, "Entertainment", "Cable TV"),
    "airlines": _b(1.19, 0.76, "Air Transport"),
    "transport": _b(0.95, 0.80, "Transportation", "Transportation (Railroads)", "Trucking"),
    "utilities": _b(0.42, 0.27, "Utility (General)", "Power"),
    "reits": _b(0.64, 0.40, "R.E.I.T."),
    "chemicals": _b(0.98, 0.75, "Chemical (Diversified)", "Chemical (Specialty)", "Chemical (Basic)"),
    "market": _b(0.91, 0.76, "Total Market"),
}

DEFAULT_FACTORS = MacroFactors(
    # Placeholder until the first sync; `as_of` marks it as such.
    risk_free_rate=RiskFreeRate(0.0510, "2026-10-15", TREASURY_SOURCE),
    equity_risk_premium=EquityRiskPremium(
        0.0446, "2026-01-05", "Damodaran, Country Default Spreads and Risk Premiums (United States total ERP)"
    ),
    sector_betas=DEFAULT_SECTOR_BETAS,
    sector_betas_source="Damodaran, Betas by Sector (US), January 2026 — mapped to peer groups",
    updated_at="2026-10-16T00:00:00Z",
)


# ---------------------------------------------------------------- local JSON cache


class MacroFactorsError(Exception):
    pass


def _path(path: str | Path | None, settings: Settings | None = None) -> Path:
    return Path(path) if path else Path((settings or get_settings()).macro_factors_path)


def _to_json(factors: MacroFactors) -> dict[str, Any]:
    return asdict(factors)


def _from_json(raw: dict[str, Any]) -> MacroFactors:
    return MacroFactors(
        risk_free_rate=RiskFreeRate(**raw["risk_free_rate"]),
        equity_risk_premium=EquityRiskPremium(**raw["equity_risk_premium"]),
        sector_betas={k: SectorBeta(**v) for k, v in raw["sector_betas"].items()},
        sector_betas_source=raw["sector_betas_source"],
        updated_at=raw["updated_at"],
        schema_version=raw.get("schema_version", SCHEMA_VERSION),
    )


def save_macro_factors(factors: MacroFactors, path: str | Path | None = None) -> Path:
    """Writes atomically (temp file + rename), so a crash mid-write never leaves a half-written file."""
    target = _path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".macro_factors.", suffix=".json", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(_to_json(factors), f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o644)  # mkstemp creates 0600; this is shared config, not a secret
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return target


def load_macro_factors(path: str | Path | None = None) -> MacroFactors:
    """The active factors, read from the JSON file on every call.

    Nothing is held in process memory: the file is the only copy, and it changes only on a sync
    event (the Station's "Sync Live Market Factors" button, or running this module directly).
    Creates the file from defaults if missing; falls back to defaults (without overwriting, so
    hand edits can be fixed) if it can't be parsed.
    """
    target = _path(path)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        save_macro_factors(DEFAULT_FACTORS, target)
        return DEFAULT_FACTORS
    try:
        return _from_json(json.loads(raw))
    except (ValueError, KeyError, TypeError) as exc:
        logger.warning("Ignoring unreadable macro factors file %s (%s); using defaults", target, exc)
        return DEFAULT_FACTORS


# ---------------------------------------------------------------- live 10-year yield


@dataclass(frozen=True)
class YieldObservation:
    as_of: date
    percent: float  # as published: 5.10 = 5.10%
    source: str


def parse_treasury_csv(text: str) -> YieldObservation | None:
    """Latest '10 Yr' value from Treasury's daily par yield curve CSV (dates are MM/DD/YYYY)."""
    latest: YieldObservation | None = None
    for row in csv.DictReader(io.StringIO(text)):
        raw, day = (row.get("10 Yr") or "").strip(), (row.get("Date") or "").strip()
        if not raw or not day:
            continue
        try:
            obs = YieldObservation(datetime.strptime(day, "%m/%d/%Y").date(), float(raw), TREASURY_SOURCE)
        except ValueError:
            continue
        if latest is None or obs.as_of > latest.as_of:
            latest = obs
    return latest


def parse_fred_csv(text: str) -> YieldObservation | None:
    """Latest DGS10 value from FRED's fredgraph CSV; holidays appear as blank values and are skipped."""
    latest: YieldObservation | None = None
    for row in csv.DictReader(io.StringIO(text)):
        day = (row.get("observation_date") or row.get("DATE") or "").strip()
        raw = (row.get(FRED_SERIES) or "").strip()
        if not raw or raw == ".":
            continue
        try:
            obs = YieldObservation(date.fromisoformat(day), float(raw), FRED_SOURCE)
        except ValueError:
            continue
        if latest is None or obs.as_of > latest.as_of:
            latest = obs
    return latest


def parse_fred_api(payload: dict[str, Any]) -> YieldObservation | None:
    for obs in payload.get("observations", []):  # requested newest first
        if obs.get("value") not in (None, "", "."):
            try:
                return YieldObservation(date.fromisoformat(obs["date"]), float(obs["value"]), FRED_SOURCE)
            except (KeyError, ValueError):
                continue
    return None


async def fetch_treasury_10y(client: httpx.AsyncClient, today: date | None = None) -> YieldObservation | None:
    """This month's and last month's files, so the 1st of a month (before any print) still works."""
    today = today or date.today()
    months = sorted({today.strftime("%Y%m"), (today.replace(day=1) - timedelta(days=1)).strftime("%Y%m")}, reverse=True)

    async def month_file(month: str) -> YieldObservation | None:
        try:
            response = await client.get(
                TREASURY_CSV_URL.format(month=month),
                params={"type": "daily_treasury_yield_curve", "field_tdr_date_value_month": month, "_format": "csv"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("Treasury yield curve request failed for %s: %s", month, type(exc).__name__)
            return None
        return parse_treasury_csv(response.text)

    observations = [o for o in await asyncio.gather(*(month_file(m) for m in months)) if o]
    return max(observations, key=lambda o: o.as_of, default=None)


async def fetch_fred_10y(client: httpx.AsyncClient, api_key: str | None, today: date | None = None) -> YieldObservation | None:
    try:
        if api_key:
            response = await client.get(
                FRED_API_URL,
                params={"series_id": FRED_SERIES, "api_key": api_key, "file_type": "json", "sort_order": "desc", "limit": 10},
            )
            response.raise_for_status()
            return parse_fred_api(response.json())
        since = ((today or date.today()) - timedelta(days=45)).isoformat()
        response = await client.get(FRED_CSV_URL, params={"id": FRED_SERIES, "cosd": since})
        response.raise_for_status()
        return parse_fred_csv(response.text)
    except (httpx.HTTPError, ValueError) as exc:
        # Never log the request URL: with an API key it contains the key.
        logger.warning("FRED request failed: %s", type(exc).__name__)
        return None


async def _within(coro, seconds: float, name: str) -> YieldObservation | None:
    """A source that's slow (home.treasury.gov can take 30s+) shouldn't hold the sync hostage: the
    other source's figure is used instead."""
    try:
        return await asyncio.wait_for(coro, seconds)
    except TimeoutError:
        logger.warning("%s didn't respond within %.0fs; using the other source", name, seconds)
        return None


def latest_observation(*observations: YieldObservation | None) -> YieldObservation | None:
    """Newest date wins; on a tie Treasury (the original publisher) is preferred over FRED."""
    candidates = [o for o in observations if o is not None]
    return max(candidates, key=lambda o: (o.as_of, o.source == TREASURY_SOURCE), default=None)


async def sync_live_market_factors(
    path: str | Path | None = None,
    *,
    settings: Settings | None = None,
    client: httpx.AsyncClient | None = None,
    today: date | None = None,
) -> MacroFactors:
    """Fetches the latest 10-year Treasury yield, writes it to the local JSON file and returns the result.

    Runs only on an explicit request (the Station's sync button or `python -m app.services.macro_rates`),
    never on import or app startup. If neither source responds, the file is left untouched and MacroFactorsError is raised.
    Once finished — successfully or not — downloaded payloads are dropped and a full garbage-collection
    pass runs, so a long-lived caller doesn't hold on to them.
    """
    settings = settings or get_settings()
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20.0, headers={"User-Agent": settings.sec_user_agent}, follow_redirects=True)
    try:
        api_key = settings.fred_api_key.get_secret_value() if settings.fred_api_key else None
        treasury, fred = await asyncio.gather(
            _within(fetch_treasury_10y(client, today), settings.macro_sync_source_timeout_seconds, "Treasury"),
            _within(fetch_fred_10y(client, api_key, today), settings.macro_sync_source_timeout_seconds, "FRED"),
        )
        latest = latest_observation(treasury, fred)
        if latest is None:
            raise MacroFactorsError("Couldn't fetch the 10-year Treasury yield from Treasury or FRED; macro factors left unchanged")

        current = load_macro_factors(path)
        if latest.as_of.isoformat() < current.risk_free_rate.as_of:
            # Only an older print was reachable (e.g. Treasury timed out, FRED lags a day): keep the newer one.
            logger.info("Fetched %s from %s is older than the cached %s; keeping it", latest.as_of, latest.source, current.risk_free_rate.as_of)
            return current
        updated = replace(
            current,
            risk_free_rate=RiskFreeRate(value=round(latest.percent / 100, 6), as_of=latest.as_of.isoformat(), source=latest.source),
            updated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        save_macro_factors(updated, path)
        return updated
    finally:
        if owns_client:
            await client.aclose()
        # Release the HTTP client, response bodies and parsed rows right away rather than at the
        # next automatic collection.
        del client
        gc.collect()


_sync_lock = asyncio.Lock()


async def sync_once(**kwargs: Any) -> MacroFactors:
    """For request handlers: overlapping clicks share one fetch instead of racing to write the file."""
    if _sync_lock.locked():
        async with _sync_lock:  # another sync is in flight — wait for it and return its result
            return load_macro_factors(kwargs.get("path"))
    async with _sync_lock:
        return await sync_live_market_factors(**kwargs)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request lines would echo FRED keys
    try:
        factors = asyncio.run(sync_live_market_factors())
    except MacroFactorsError as exc:
        raise SystemExit(str(exc)) from None
    rf, erp = factors.risk_free_rate, factors.equity_risk_premium
    print(f"10-year Treasury yield: {rf.value * 100:.2f}% as of {rf.as_of} ({rf.source})")
    print(f"Equity risk premium:    {erp.value * 100:.2f}% as of {erp.as_of} (unchanged)")
    print(f"Market cost of equity:  {factors.cost_of_equity(None) * 100:.2f}% (β {factors.beta_for(None).beta:.2f})")
    print(f"Saved to {_path(None)}")


if __name__ == "__main__":
    main()
