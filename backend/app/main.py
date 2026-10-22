import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.cache_headers import CacheHeaders
from app.core.config import get_settings
from app.services.data_router import DataRouter
from app.services.fmp_client import FmpClient, FmpError
from app.services.narrative import NarrativeError, NarrativeService, build_claude_client
from app.services.financials_service import FinancialsService
from app.services.dcf_inputs import DcfInputsService
from app.services.fx import FxService
from app.services.market_caps import MarketCaps
from app.services.quotes import QuoteService
from app.services.news import NewsError, NewsService
from app.services.sec_client import SecApiError, SecEdgarClient
from app.services.filed_relationships import FiledRelationships
from app.services.relationship_notes import RelationshipNotes
from app.services.supply_chain import SupplyChainError, SupplyChainStore
from app.services.warmup import keep_warm


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One shared client so the rate limiter and cache apply across all requests.
    settings = get_settings()
    app.state.sec_client = SecEdgarClient()
    app.state.fmp_client = FmpClient(settings)
    app.state.data_router = DataRouter(app.state.sec_client)
    app.state.quote_service = QuoteService(app.state.fmp_client, settings)
    app.state.fx_service = FxService(app.state.quote_service)
    app.state.dcf_service = DcfInputsService(
        FinancialsService(app.state.sec_client, app.state.fmp_client, app.state.data_router, app.state.quote_service), app.state.quote_service
    )
    app.state.supply_chain_store = SupplyChainStore()
    app.state.filed_relationships = FiledRelationships(app.state.sec_client, app.state.data_router)
    app.state.relationship_notes = RelationshipNotes(
        app.state.sec_client, app.state.data_router, app.state.supply_chain_store, filed=app.state.filed_relationships
    )
    app.state.market_caps = MarketCaps(app.state.sec_client, app.state.quote_service)
    app.state.news_service = NewsService(settings)
    claude = build_claude_client(settings)
    app.state.narrative_service = NarrativeService(app.state.sec_client, claude, settings)
    # Keep the first-load companies cached (off in tests, which use their own fakes).
    warmer = asyncio.create_task(keep_warm(app)) if settings.warm_cache else None
    yield
    if warmer:
        warmer.cancel()
    await app.state.sec_client.aclose()
    await app.state.fmp_client.aclose()
    await app.state.quote_service.aclose()
    await app.state.news_service.aclose()
    if claude is not None:
        await claude.close()


app = FastAPI(title="MacroPulse API", lifespan=lifespan)

# The full US list is ~1–2 MB of JSON: compress responses.
app.add_middleware(GZipMiddleware, minimum_size=1024)
# Browser caching (Cache-Control with stale-while-revalidate) on successful GETs.
app.add_middleware(CacheHeaders)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(SecApiError)
async def sec_error_handler(_: Request, exc: SecApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(FmpError)
async def fmp_error_handler(_: Request, exc: FmpError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc), "code": exc.code})


@app.exception_handler(NarrativeError)
async def narrative_error_handler(_: Request, exc: NarrativeError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc), "code": exc.code})


@app.exception_handler(SupplyChainError)
async def supply_chain_error_handler(_: Request, exc: SupplyChainError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(NewsError)
async def news_error_handler(_: Request, exc: NewsError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


app.include_router(router)
