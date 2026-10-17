from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import get_settings
from app.services.data_router import DataRouter
from app.services.fmp_client import FmpClient, FmpError
from app.services.narrative import NarrativeError, NarrativeService, build_claude_client
from app.services.financials_service import FinancialsService
from app.services.gurufocus import GuruFocusService
from app.services.quotes import QuoteService
from app.services.news import NewsError, NewsService
from app.services.sec_client import SecApiError, SecEdgarClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One shared client so the rate limiter and cache apply across all requests.
    settings = get_settings()
    app.state.sec_client = SecEdgarClient()
    app.state.fmp_client = FmpClient(settings)
    app.state.data_router = DataRouter(app.state.sec_client)
    app.state.quote_service = QuoteService(app.state.fmp_client, settings)
    app.state.gurufocus_service = GuruFocusService(
        FinancialsService(app.state.sec_client, app.state.fmp_client, app.state.data_router), app.state.quote_service
    )
    app.state.news_service = NewsService(settings)
    claude = build_claude_client(settings)
    app.state.narrative_service = NarrativeService(app.state.sec_client, claude, settings)
    yield
    await app.state.sec_client.aclose()
    await app.state.fmp_client.aclose()
    await app.state.quote_service.aclose()
    await app.state.news_service.aclose()
    if claude is not None:
        await claude.close()


app = FastAPI(title="MacroPulse API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
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


@app.exception_handler(NewsError)
async def news_error_handler(_: Request, exc: NewsError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


app.include_router(router)
