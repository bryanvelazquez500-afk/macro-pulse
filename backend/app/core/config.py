from functools import lru_cache
from pathlib import Path

import json
from typing import Annotated

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="IS_", extra="ignore")

    # The SEC requires every automated request to identify itself with a
    # "Company Name contact@email" User-Agent. Requests without one are blocked.
    sec_user_agent: str = "InvestmentStation student@domain.com"

    sec_data_base_url: str = "https://data.sec.gov"
    sec_www_base_url: str = "https://www.sec.gov"

    # SEC fair-access policy caps clients at 10 requests/second.
    sec_max_requests_per_second: int = 10
    sec_timeout_seconds: float = 20.0

    # Responses are cached in memory so repeat lookups don't hit the SEC again.
    cache_ttl_seconds: int = 60 * 60
    # Replay the first-load requests at startup and every 45 minutes (see services/warmup.py).
    warm_cache: bool = True

    # Narrative summaries (Claude). When unset, the Anthropic SDK falls back to its own
    # credential discovery (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile).
    anthropic_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "IS_ANTHROPIC_API_KEY")
    )
    narrative_model: str = "claude-opus-5-5"
    # MD&A text doesn't change once filed, so summaries are cached per filing for a day.
    narrative_cache_ttl_seconds: int = 24 * 60 * 60

    news_cache_ttl_seconds: int = 5 * 60

    # Macro valuation factors (app/services/macro_rates.py). The JSON file holds the active
    # risk-free rate, equity risk premium and sector betas; `python -m app.services.macro_rates`
    # refreshes the 10-year Treasury yield in it. A FRED key is optional — without one the
    # keyless FRED CSV download is used.
    macro_factors_path: str = str(Path(__file__).resolve().parents[2] / "data" / "macro_factors.json")
    fred_api_key: SecretStr | None = Field(default=None, validation_alias=AliasChoices("FRED_API_KEY", "IS_FRED_API_KEY"))
    # Per-source budget for a sync (both sources are queried in parallel).
    macro_sync_source_timeout_seconds: float = 8.0

    # Global pipeline: Financial Modeling Prep, for international listings with no SEC filings.
    # Free keys are limited to US symbols, 5 periods per request and 250 requests/day, so
    # non-US statements need a paid plan; requests fail with a clear 402 otherwise.
    fmp_api_key: SecretStr | None = Field(default=None, validation_alias=AliasChoices("FMP_API_KEY", "IS_FMP_API_KEY"))
    fmp_base_url: str = "https://financialmodelingprep.com/stable"
    fmp_timeout_seconds: float = 20.0
    # Periods requested per statement; automatically retried at the free plan's cap of 5.
    fmp_statement_limit: int = 10
    # Statements change at most quarterly; caching for 6h keeps us well inside daily quotas.
    fmp_cache_ttl_seconds: int = 6 * 60 * 60

    # Frontend origins allowed to call the API. In production set IS_CORS_ORIGINS to the deployed
    # frontend's origin — either a comma-separated list or a JSON array.
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                return json.loads(text)
            return [o.strip().rstrip("/") for o in text.split(",") if o.strip()]
        return value

    # Host of the deployed website (Render fills it in from the static site's service, see render.yaml);
    # its https origin is allowed on top of cors_origins.
    web_host: str | None = None

    @property
    def allowed_origins(self) -> list[str]:
        extra = [f"https://{self.web_host.strip().removeprefix('https://').rstrip('/')}"] if self.web_host else []
        return [*self.cors_origins, *extra]


@lru_cache
def get_settings() -> Settings:
    return Settings()
