"""Settings: the API allows the deployed website's origin."""

from app.core.config import Settings


def test_allowed_origins_include_the_static_site_host():
    s = Settings(cors_origins="https://macropulse-z27l.onrender.com", web_host="macropulse-web.onrender.com")
    assert s.allowed_origins == ["https://macropulse-z27l.onrender.com", "https://macropulse-web.onrender.com"]
    assert Settings(cors_origins="http://localhost:3000").allowed_origins == ["http://localhost:3000"]
