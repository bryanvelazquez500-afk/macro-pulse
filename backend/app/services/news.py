"""Live headlines for a ticker from the Google News RSS search feed (no API key required)."""

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


def parse_feed(xml: str) -> list[Headline]:
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
        source = (item.findtext("source") or "").strip() or None
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
            headers={"User-Agent": settings.sec_user_agent}, timeout=10.0, follow_redirects=True, transport=transport
        )
        self._cache = TTLCache(settings.news_cache_ttl_seconds)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def headlines(self, ticker: str, limit: int = 10) -> list[Headline]:
        # Quoting the symbol keeps matches to the ticker; the 7-day window keeps it live.
        query = f'"{ticker}" stock when:7d'
        cached = self._cache.get(query)
        if cached is None:
            try:
                response = await self._client.get(FEED_URL.format(query=quote_plus(query)))
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise NewsError(f"Could not reach the news feed: {exc}") from exc
            cached = parse_feed(response.text)
            self._cache.set(query, cached)
        return cached[:limit]
