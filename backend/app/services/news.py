"""Live headlines for a ticker from public RSS feeds (no API key required).

Google News is tried first (broadest coverage). Google refuses many cloud-hosting IPs (Render gets
HTTP 503), so Yahoo Finance's per-ticker headline feed is the fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus, urlparse

import httpx
from defusedxml import DefusedXmlException, ElementTree

from app.core.config import Settings
from app.services.sec_client import TTLCache

FEED_URL = "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
YAHOO_FEED_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"


class NewsError(Exception):
    pass


@dataclass(frozen=True)
class Headline:
    title: str
    url: str
    source: str | None
    published_at: datetime | None


def _is_http_url(url: str) -> bool:
    return urlparse(url).scheme in {"http", "https"}


def parse_feed(xml: str, default_source: str | None = None) -> list[Headline]:
    """Parses RSS into headlines, newest first. Uses defusedxml since the feed is third-party input."""
    try:
        root = ElementTree.fromstring(xml)
    except (ElementTree.ParseError, DefusedXmlException) as exc:
        raise NewsError("News feed returned malformed or unsafe XML") from exc

    headlines: list[Headline] = []
    seen: set[str] = set()
    for item in root.iterfind("./channel/item"):
        title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        if not title or not _is_http_url(url):
            continue
        source = (item.findtext("source") or "").strip() or default_source
        # Google appends " - Source" to every title; the source is shown separately.
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3].rstrip()
        if title.lower() in seen:
            continue  # syndicated duplicates
        seen.add(title.lower())
        try:
            published = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            published = None
        headlines.append(Headline(title=title, url=url, source=source, published_at=published))

    return sorted(headlines, key=lambda h: h.published_at.timestamp() if h.published_at else 0, reverse=True)


class NewsService:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(
            # A browser-like agent: feed hosts reject obvious bots.
            headers={"User-Agent": "Mozilla/5.0 (MacroPulse news reader)"}, timeout=10.0, follow_redirects=True, transport=transport
        )
        self._cache = TTLCache(settings.news_cache_ttl_seconds)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def latest(self, ticker: str, limit: int = 10) -> tuple[str, list[Headline]]:
        """(provider, headlines newest first). Google News, else Yahoo Finance."""
        cached = self._cache.get(ticker)
        if cached is None:
            # Quoting the symbol keeps matches to the ticker; the 7-day window keeps it live.
            query = f'"{ticker}" stock when:7d'
            errors: list[str] = []
            for provider, url, default_source in (
                ("Google News", FEED_URL.format(query=quote_plus(query)), None),
                ("Yahoo Finance", YAHOO_FEED_URL.format(ticker=quote_plus(ticker)), "Yahoo Finance"),
            ):
                try:
                    response = await self._client.get(url)
                    response.raise_for_status()
                    items = parse_feed(response.text, default_source)
                except (httpx.HTTPError, NewsError) as exc:
                    errors.append(f"{provider}: {type(exc).__name__}")
                    continue
                if items:
                    cached = (provider, items)
                    break
                errors.append(f"{provider}: no headlines")
            if cached is None:
                raise NewsError("Could not reach the news feeds (" + "; ".join(errors) + ")")
            self._cache.set(ticker, cached)
        return cached[0], cached[1][:limit]

    async def headlines(self, ticker: str, limit: int = 10) -> list[Headline]:
        return (await self.latest(ticker, limit))[1]
