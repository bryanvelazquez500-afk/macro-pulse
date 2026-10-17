import httpx
import pytest

from app.core.config import Settings
from app.services.news import NewsError, NewsService, parse_feed

FEED = """<?xml version="1.0"?><rss><channel>
<item><title>Apple Stock Slips - Yahoo Finance</title><link>https://news.google.com/a</link>
  <pubDate>Fri, 09 Oct 2026 23:15:10 GMT</pubDate><source url="https://finance.yahoo.com">Yahoo Finance</source></item>
<item><title>AAPL Hits Record</title><link>https://news.google.com/b</link>
  <pubDate>Wed, 14 Oct 2026 00:41:12 GMT</pubDate><source url="https://stocktwits.com">Stocktwits</source></item>
<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Thu, 15 Oct 2026 00:00:00 GMT</pubDate></item>
<item><title>AAPL hits record</title><link>https://news.google.com/c</link><pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://news.google.com/d</link></item>
</channel></rss>"""


def test_parse_feed_sorts_newest_first_and_cleans_titles():
    items = parse_feed(FEED)
    assert [h.title for h in items] == ["AAPL Hits Record", "Apple Stock Slips", "No date"]
    assert items[1].source == "Yahoo Finance"  # " - Yahoo Finance" suffix stripped from the title


def test_parse_feed_rejects_non_http_links_and_duplicates():
    urls = [h.url for h in parse_feed(FEED)]
    assert all(u.startswith("https://") for u in urls)
    assert "https://news.google.com/c" not in urls  # case-insensitive duplicate title


def test_parse_feed_rejects_entity_expansion():
    bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss>&b;</rss>'
    with pytest.raises(NewsError):
        parse_feed(bomb)


async def test_headlines_limit_and_query():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=FEED)

    service = NewsService(Settings(), transport=httpx.MockTransport(handler))
    items = await service.headlines("AAPL", limit=2)
    await service.headlines("AAPL", limit=2)  # served from cache
    await service.aclose()
    assert len(items) == 2
    assert len(seen) == 1
    assert seen[0].url.params["q"] == '"AAPL" stock when:7d'


async def test_feed_outage_raises_news_error():
    service = NewsService(Settings(), transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with pytest.raises(NewsError):
        await service.headlines("AAPL")
    await service.aclose()
