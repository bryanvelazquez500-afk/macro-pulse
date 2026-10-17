"""Serves company profiles and standardized financials from either data pipeline.

The `DataRouter` picks SEC EDGAR (US companies and foreign SEC registrants) or Financial Modeling
Prep (other international listings). Both pipelines produce the same `NormalizedPeriod`s, so audit
ratios, YoY variances and the Piotroski / Altman / Sloan scores run unchanged on either.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.models import CompanyProfile, Filing, FinancialPeriod, FinancialsResponse, Forensics, MetricValue, Ratio, Variance
from app.services.data_router import DataRouter, DataSource, Route
from app.services.fmp_client import FmpClient, FmpError
from app.services.fmp_mapping import fmp_tag_map, normalize_fmp_statements
from app.services.forensics import compute_forensics
from app.services.gaap_mapping import (
    STANDARD_LABELS,
    Metric,
    NormalizedPeriod,
    PeriodType,
    detect_reporting_basis,
    normalize_company_facts,
    tag_map_for,
)
from app.services.peers import match_peer_group
from app.services.ratios import compute_ratios
from app.services.sec_client import SecEdgarClient, format_cik
from app.services.variance import DEFAULT_MATERIALITY_THRESHOLD, compute_variances, find_prior_year_period

FMP_STANDARD_LABEL = "FMP standardized"


@dataclass(frozen=True)
class LoadedFinancials:
    route: Route
    periods: list[NormalizedPeriod]  # newest first
    currency: str
    accounting_standard: str
    entity_name: str
    tag_map: dict[str, list[str]]

# 6-K interim reports are left out: foreign filers file dozens a year and would bury the 20-F.
_KEY_FORMS = {"10-K", "10-Q", "8-K", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A", "DEF 14A"}


def _recent_filings(submissions: dict[str, Any], cik: int, limit: int) -> list[Filing]:
    recent = submissions.get("filings", {}).get("recent", {})
    filings: list[Filing] = []
    for i, form in enumerate(recent.get("form", [])):
        if form not in _KEY_FORMS:
            continue
        accession = recent["accessionNumber"][i]
        primary_doc = recent["primaryDocument"][i]
        filings.append(
            Filing(
                form=form,
                accession_number=accession,
                filing_date=recent["filingDate"][i],
                report_date=recent["reportDate"][i] or None,
                url=f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{primary_doc}",
            )
        )
        if len(filings) >= limit:
            break
    return filings


def _build_periods(all_periods: list[NormalizedPeriod], limit: int, variance_threshold: float) -> list[FinancialPeriod]:
    # Variances use the full history so the oldest displayed period still has its prior year.
    variances = compute_variances(all_periods, variance_threshold)
    return [
        FinancialPeriod(
            start=p.start,
            end=p.end,
            fiscal_year=p.fiscal_year,
            fiscal_period=p.fiscal_period,
            line_items={metric.value: MetricValue(**asdict(v)) if (v := p.values.get(metric)) else None for metric in Metric},
            ratios={key.value: Ratio(**asdict(r)) if r else None for key, r in compute_ratios(p).items()},
            variances={
                metric.value: Variance(
                    prior_value=v.prior_value,
                    change_pct=v.change_pct,
                    flagged=v.flagged,
                    direction=v.direction,
                    severity_tier=v.severity_tier,
                    prior_period_end=v.prior_period_end,
                    prior_fiscal_year=v.prior_fiscal_year,
                    prior_fiscal_period=v.prior_fiscal_period,
                )
                for metric, v in variances.get(p.key, {}).items()
            },
            forensics=Forensics.model_validate(asdict(compute_forensics(p, find_prior_year_period(p, all_periods)))),
        )
        for p in all_periods[:limit]
    ]


class FinancialsService:
    def __init__(self, sec: SecEdgarClient, fmp: FmpClient, router: DataRouter | None = None):
        self.sec = sec
        self.fmp = fmp
        self.router = router or DataRouter(sec)

    async def get_profile(self, identifier: str, filings_limit: int = 10) -> CompanyProfile:
        route = await self.router.resolve(identifier)
        if route.source is DataSource.FMP:
            return await self._fmp_profile(route)

        sub = await self.sec.get_submissions(route.cik)
        tickers, exchanges = sub.get("tickers", []), sub.get("exchanges", [])
        group = match_peer_group(tickers[0].upper() if tickers else None, str(sub.get("sic") or "") or None)
        if route.listing:
            # Lead with the home listing the user asked for; the US tickers stay available for matching.
            tickers = [route.symbol, *(t for t in tickers if t != route.symbol)]
            exchanges = [route.listing.exchange.name, *exchanges]
        return CompanyProfile(
            cik=format_cik(route.cik),
            source=DataSource.SEC.value,
            symbol=route.symbol,
            name=sub.get("name", ""),
            tickers=tickers,
            exchanges=exchanges,
            sic=sub.get("sic") or None,
            sic_description=sub.get("sicDescription") or None,
            fiscal_year_end=sub.get("fiscalYearEnd") or None,
            state_of_incorporation=sub.get("stateOfIncorporation") or None,
            country=route.listing.exchange.country if route.listing else None,
            peer_group=group.group_key if group else None,
            peer_group_label=group.label if group else None,
            recent_filings=_recent_filings(sub, route.cik, filings_limit),
        )

    async def _fmp_profile(self, route: Route) -> CompanyProfile:
        p: dict[str, Any] = await self.fmp.get_profile(route.symbol)
        exchange = p.get("exchangeFullName") or p.get("exchange") or (route.listing.exchange.name if route.listing else None)
        return CompanyProfile(
            cik=None,
            source=DataSource.FMP.value,
            symbol=route.symbol,
            name=p.get("companyName") or route.symbol,
            tickers=[route.symbol],
            exchanges=[exchange] if exchange else [],
            sic=None,
            sic_description=p.get("industry") or p.get("sector") or None,
            fiscal_year_end=None,
            state_of_incorporation=None,
            country=p.get("country") or (route.listing.exchange.country if route.listing else None),
            recent_filings=[],
        )

    async def load_periods(self, identifier: str, period_type: PeriodType, cache_facts: bool = True) -> LoadedFinancials:
        """Normalized periods (newest first) from whichever pipeline serves the identifier."""
        route = await self.router.resolve(identifier)
        if route.source is DataSource.FMP:
            normalized = normalize_fmp_statements(await self.fmp.get_statements(route.symbol, period_type), period_type)
            try:
                name = (await self.fmp.get_profile(route.symbol)).get("companyName") or route.symbol
            except FmpError:
                name = route.symbol  # the profile is cosmetic here; statements already loaded
            return LoadedFinancials(
                route=route,
                periods=normalized.periods,
                currency=normalized.currency or "USD",
                accounting_standard=FMP_STANDARD_LABEL,
                entity_name=name,
                tag_map={metric.value: tags for metric, tags in fmp_tag_map().items()},
            )

        facts = await self.sec.get_company_facts(route.cik, cache=cache_facts)
        basis = detect_reporting_basis(facts)
        taxonomies = facts.get("facts", {}).keys()
        return LoadedFinancials(
            route=route,
            periods=normalize_company_facts(facts, period_type, basis),
            currency=basis.currency,
            accounting_standard=STANDARD_LABELS[basis.standard],
            entity_name=facts.get("entityName", ""),
            # Only the taxonomies this company actually files in.
            tag_map={
                metric.value: [t for t in tags if (t.rpartition(":")[0] or "us-gaap") in taxonomies]
                for metric, tags in tag_map_for(basis).items()
            },
        )

    async def get_financials(
        self,
        identifier: str,
        period_type: PeriodType,
        limit: int,
        variance_threshold: float = DEFAULT_MATERIALITY_THRESHOLD,
    ) -> FinancialsResponse:
        loaded = await self.load_periods(identifier, period_type)
        route = loaded.route
        return FinancialsResponse(
            cik=format_cik(route.cik) if route.cik is not None else None,
            symbol=route.symbol,
            source=route.source.value,
            accounting_standard=loaded.accounting_standard,
            currency=loaded.currency,
            entity_name=loaded.entity_name,
            period_type=period_type,
            variance_threshold_pct=variance_threshold * 100,
            periods=_build_periods(loaded.periods, limit, variance_threshold),
            tag_map=loaded.tag_map,
        )
