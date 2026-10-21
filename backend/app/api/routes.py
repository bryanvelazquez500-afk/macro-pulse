from fastapi import APIRouter, Depends, HTTPException, Query, Request

from dataclasses import asdict

from app.models import (
    BasisInputModel,
    DcfInputsResponse,
    LiveQuoteResponse,
    SupplyChainEdgeModel,
    SupplyChainNodeModel,
    SupplyChainResponse,
    RelationshipContextModel,
    CoveredCompanyModel,
    CountryLeadersResponse,
    DiscoveryCountriesResponse,
    LeaderModel,
    SnapshotModel,
    BetaChoiceModel,
    MacroFactorsResponse,
    RateModel,
    ValuationInputsResponse,
    QuoteModel,
    CompanyProfile,
    Filing,
    FinancialsResponse,
    NarrativeBullet,
    NarrativeResponse,
    NewsItem,
    NewsResponse,
    PeerItem,
    PeersResponse,
)
from app.services.macro_rates import MacroFactors, MacroFactorsError, load_macro_factors, sync_once
from app.services.valuation_inputs import get_valuation_inputs
from app.services.data_router import DataRouter, DataSource
from app.services.discovery import LEADERS, LIST_AS_OF, SECTORS, country_count, country_leaders
from app.services.financials_service import FinancialsService
from app.services.fmp_client import FmpError
from app.services.gaap_mapping import PeriodType
from app.services.narrative import NarrativeService
from app.services.news import NewsService
from app.services.peers import suggest_peers
from app.services.relationship_notes import RelationshipNotFoundError
from app.services.supply_chain import build_graph
from app.services.universe import search
from app.services.variance import DEFAULT_MATERIALITY_THRESHOLD

router = APIRouter(prefix="/api")


def get_service(request: Request) -> FinancialsService:
    state = request.app.state
    return FinancialsService(state.sec_client, state.fmp_client, state.data_router, state.quote_service)


def get_router(request: Request) -> DataRouter:
    return request.app.state.data_router


def get_news_service(request: Request) -> NewsService:
    return request.app.state.news_service


def get_narrative_service(request: Request) -> NarrativeService:
    return request.app.state.narrative_service


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/companies/{identifier}", response_model=CompanyProfile)
async def company_profile(identifier: str, service: FinancialsService = Depends(get_service)) -> CompanyProfile:
    """Company metadata. `identifier` is a US ticker, a CIK, or an international listing (ASML.AS, VOD.L)."""
    return await service.get_profile(identifier)


@router.get("/companies/{identifier}/financials", response_model=FinancialsResponse)
async def company_financials(
    identifier: str,
    period: PeriodType = Query(PeriodType.ANNUAL),
    limit: int = Query(10, ge=1, le=60),
    variance_threshold: float = Query(DEFAULT_MATERIALITY_THRESHOLD, gt=0, le=1, description="Materiality threshold as a fraction (0.10 = 10%)"),
    service: FinancialsService = Depends(get_service),
) -> FinancialsResponse:
    """Standardized statements, audit ratios, YoY variances and forensic scores.

    US companies and foreign SEC registrants come from SEC CompanyFacts (US GAAP or IFRS, in the
    company's reporting currency); other international listings from Financial Modeling Prep.
    """
    return await service.get_financials(identifier, period, limit, variance_threshold)


@router.get("/companies/{identifier}/news", response_model=NewsResponse)
async def company_news(
    identifier: str,
    limit: int = Query(10, ge=1, le=25),
    service: FinancialsService = Depends(get_service),
    news: NewsService = Depends(get_news_service),
) -> NewsResponse:
    """Most recent market headlines mentioning the company's primary ticker (Google News RSS, else Yahoo Finance; last 7 days)."""
    try:
        profile = await service.get_profile(identifier, filings_limit=0)
        ticker = profile.tickers[0] if profile.tickers else profile.name
    except FmpError:
        # Headlines only need the symbol, so they don't depend on the global provider's plan.
        ticker = identifier.strip().upper()
    provider, items = await news.latest(ticker, limit)
    return NewsResponse(ticker=ticker, provider=provider, items=[NewsItem(**asdict(h)) for h in items])


@router.get("/companies/{identifier}/narrative", response_model=NarrativeResponse)
async def company_narrative(
    identifier: str,
    narrative: NarrativeService = Depends(get_narrative_service),
    router: DataRouter = Depends(get_router),
) -> NarrativeResponse:
    """Claude-synthesized executive bullets from Item 7 (MD&A) of the latest 10-K. Cached per filing."""
    route = await router.resolve(identifier)
    if route.source is not DataSource.SEC:
        raise HTTPException(404, "MD&A narratives need SEC filings; this company isn't an SEC registrant.")
    s = await narrative.summarize(str(route.cik))
    return NarrativeResponse(
        entity_name=s.entity_name,
        filing=Filing(**asdict(s.filing)),
        mdna_chars=s.mdna_chars,
        model=s.model,
        bullets=[NarrativeBullet(**{**asdict(b), "theme": b.theme.value}) for b in s.bullets],
    )


@router.get("/companies/{identifier}/peers", response_model=PeersResponse)
async def company_peers(
    identifier: str, request: Request, limit: int = Query(6, ge=1, le=10), router: DataRouter = Depends(get_router)
) -> PeersResponse:
    """Industry peers chosen from the company's SIC code (see app/services/peers.py)."""
    route = await router.resolve(identifier)
    if route.source is not DataSource.SEC:
        # SIC codes are an SEC classification; companies outside EDGAR have none.
        return PeersResponse(ticker=route.symbol, sic=None, sic_description=None, group=None, basis=None, peers=[])
    s = await suggest_peers(request.app.state.sec_client, str(route.cik), limit)
    return PeersResponse(
        ticker=s.ticker,
        sic=s.sic,
        sic_description=s.sic_description,
        group=s.group,
        basis=s.basis,
        peers=[PeerItem(ticker=p.ticker, name=p.name) for p in s.peers],
    )


def _macro_response(f: MacroFactors) -> MacroFactorsResponse:
    return MacroFactorsResponse.model_validate(asdict(f))


@router.get("/macro/factors", response_model=MacroFactorsResponse)
async def macro_factors() -> MacroFactorsResponse:
    """Active valuation constants from the local JSON cache (read from disk on each request)."""
    return _macro_response(load_macro_factors())


@router.post("/macro/sync", response_model=MacroFactorsResponse)
async def macro_sync() -> MacroFactorsResponse:
    """Fetches the latest 10-year Treasury yield (Treasury / FRED) and overwrites the cached risk-free rate.

    Runs only when called — the Station's "Sync Live Market Factors" button.
    """
    try:
        return _macro_response(await sync_once())
    except MacroFactorsError as exc:
        raise HTTPException(502, str(exc)) from None


@router.get("/companies/{identifier}/valuation-inputs", response_model=ValuationInputsResponse)
async def company_valuation_inputs(
    identifier: str, request: Request, service: FinancialsService = Depends(get_service)
) -> ValuationInputsResponse:
    """Price, sector beta and macro factors for the Intrinsic Valuation Station's CAPM/DCF/DDM/Graham models."""
    v = await get_valuation_inputs(service, request.app.state.quote_service, identifier)
    q = v.price.quote
    f = v.factors
    return ValuationInputsResponse(
        symbol=v.symbol,
        currency=v.currency,
        price=QuoteModel(price=q.price, currency=q.currency, source=q.source, as_of=q.as_of, comparable=v.price.comparable, note=v.price.note) if q else None,
        price_note=v.price.note,
        beta=BetaChoiceModel(**asdict(v.beta)),
        risk_free_rate=RateModel(value=f.risk_free_rate.value, as_of=f.risk_free_rate.as_of, source=f.risk_free_rate.source),
        equity_risk_premium=RateModel(**asdict(f.equity_risk_premium)),
        aaa_yield=RateModel(value=f.aaa_yield.value, as_of=f.aaa_yield.as_of, source=f.aaa_yield.source) if f.aaa_yield else None,
    )


@router.get("/discovery/countries", response_model=DiscoveryCountriesResponse)
async def discovery_countries() -> DiscoveryCountriesResponse:
    """Countries with a curated list of leading listed companies (for the Equity Discovery map)."""
    return DiscoveryCountriesResponse(countries={iso: country_count(iso) for iso in LEADERS})


@router.get("/discovery/countries/{iso2}", response_model=CountryLeadersResponse)
async def discovery_country(iso2: str, request: Request, router_: DataRouter = Depends(get_router)) -> CountryLeadersResponse:
    """A country's largest listed companies with live price, day change, 52-week range and data coverage."""
    state = request.app.state
    leaders = await country_leaders(iso2, state.quote_service, router_, state.fmp_client, state.market_caps)
    if leaders is None:
        raise HTTPException(404, f"No curated listings for {iso2.upper()} yet")
    return CountryLeadersResponse(
        country=iso2.upper(),
        list_as_of=LIST_AS_OF,
        sectors=list(SECTORS),
        leaders=[
            LeaderModel(
                rank=l.rank,
                symbol=l.symbol,
                name=l.name,
                sector=l.sector,
                snapshot=SnapshotModel(**{k: v for k, v in asdict(l.snapshot).items() if k != "symbol"}) if l.snapshot else None,
                coverage=l.coverage,
                market_cap=l.market_cap,
                market_cap_usd=l.market_cap_usd,
            )
            for l in leaders
        ],
    )


@router.get("/companies/{identifier}/dcf-inputs", response_model=DcfInputsResponse)
async def company_dcf_inputs(identifier: str, request: Request) -> DcfInputsResponse:
    """Live inputs for the two-stage DCF calculator (see app/services/dcf_inputs.py)."""
    i = await request.app.state.dcf_service.get(identifier)
    return DcfInputsResponse(**{**asdict(i), "bases": [BasisInputModel(**asdict(b)) for b in i.bases]})


@router.get("/quotes/{symbol}", response_model=LiveQuoteResponse)
async def live_quote(symbol: str, request: Request) -> LiveQuoteResponse:
    """Latest price only (cached 5 minutes) — lets the calculator refresh P without refetching its inputs."""
    q = await request.app.state.dcf_service.quote(symbol)
    if q is None:
        raise HTTPException(404, f"No price available for {symbol.upper()}")
    return LiveQuoteResponse(symbol=q.symbol, price=q.price, currency=q.currency, source=q.source, as_of=q.as_of)


@router.get("/companies/{identifier}/supply-chain", response_model=SupplyChainResponse)
async def company_supply_chain(identifier: str, request: Request) -> SupplyChainResponse:
    """Suppliers and clients as a directed graph: curated links (data/supply_chain.json, re-read on change) plus
    those named in the company's own latest annual report (read once per filing; see filed_relationships.py)."""
    state = request.app.state
    g = await build_graph(state.supply_chain_store, state.filed_relationships, identifier)
    return SupplyChainResponse(
        focus=g.focus,
        nodes=[SupplyChainNodeModel(**asdict(n)) for n in g.nodes],
        edges=[SupplyChainEdgeModel(**asdict(e)) for e in g.edges],
        covered=[CoveredCompanyModel(id=i, name=n) for i, n in g.covered],
        filing=g.filing,
        filing_status=g.filing_status,
    )


@router.get("/supply-chain/relationship", response_model=RelationshipContextModel)
async def supply_chain_relationship(request: Request, supplier: str = Query(...), client: str = Query(...)) -> RelationshipContextModel:
    """Filing-backed context for one mapped supplier → client link (fetched on demand; see relationship_notes.py)."""
    try:
        ctx = await request.app.state.relationship_notes.context(supplier, client)
    except RelationshipNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return RelationshipContextModel.model_validate(asdict(ctx))


@router.get("/universe/search")
async def universe_search(q: str = Query(..., min_length=1, max_length=40), limit: int = Query(10, ge=1, le=25)) -> dict:
    """Ticker / company-name suggestions: every US-listed SEC filer plus the scout lists' international listings."""
    us = [{"ticker": l.ticker, "name": l.name, "exchange": l.exchange, "sector": l.sector} for l in search(q, limit)]
    if len(us) >= limit:
        return {"results": us}
    needle = q.strip().upper()
    intl = [
        {"ticker": s, "name": n, "exchange": iso, "sector": sec}
        for iso, rows in LEADERS.items() if iso != "US"
        for s, n, sec in rows
        if s.startswith(needle) or needle in n.upper()
    ]  # fmt: skip
    seen = {r["ticker"] for r in us}
    return {"results": us + [r for r in intl if r["ticker"] not in seen][: limit - len(us)]}
