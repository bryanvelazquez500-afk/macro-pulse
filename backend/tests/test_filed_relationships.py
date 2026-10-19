"""Supplier / customer links read from a company's own annual report."""

from app.services.filed_relationships import NameIndex, clean_title, direction_of, extract_links

CURATED = {
    "AAPL": {"name": "Apple", "public": True, "mentions": ["Apple"]},
    "TSM": {"name": "TSMC", "public": True, "mentions": ["TSMC", "Taiwan Semiconductor Manufacturing"]},
    "ZEISS": {"name": "Carl Zeiss SMT", "public": False, "mentions": ["Carl Zeiss SMT"]},
}
TICKERS = {
    "AMKR": {"cik": 1, "title": "AMKOR TECHNOLOGY INC"},
    "MSTR": {"cik": 2, "title": "Strategy Inc"},
    "FN": {"cik": 3, "title": "Fabrinet"},
    "NDAQ": {"cik": 4, "title": "Nasdaq, Inc."},
    "SPAC": {"cik": 5, "title": "Example Acquisition Corp. II"},
}


def test_clean_title():
    assert clean_title("AMKOR TECHNOLOGY INC") == "Amkor Technology"
    assert clean_title("Hansoh Pharmaceutical Group Co Limited/ADR") == "Hansoh Pharmaceutical"
    assert clean_title("Example Acquisition Corp. II") is None  # blank-check shell
    assert clean_title("Target Corp") is None  # ordinary word


def test_direction_from_nearest_words_and_products():
    s = "Our largest customer, Apple, accounted for 20% of revenue, while our suppliers include TSMC."
    assert direction_of(s, s.index("Apple"), 5) == "client"
    assert direction_of(s, s.index("TSMC"), 4) == "supplier"
    p = "Our clusters use AMD and Intel chips to help our customers train models."
    assert direction_of(p, p.index("AMD"), 3) == "supplier"  # "<name> … chips" = their product


def test_extract_links_skips_noise_and_ambiguous_names():
    text = (
        "Our largest customer, Apple Inc., accounted for approximately 20% of our net revenue in fiscal 2025. "
        "We rely on Taiwan Semiconductor Manufacturing Company as the sole source of our wafers for most products. "
        "Our assembly and test suppliers include Amkor Technology and Fabrinet, which package our products. "
        "Our common stock is traded on Nasdaq under the symbol XYZ and our customers can buy it there. "
        "Our strategy depends on suppliers and customers alike, as Strategy is key for our supply business plans. "
        "Carl Zeiss SMT is our sole supplier of optics, and we depend on its capacity to ship systems."
    )
    index = NameIndex(CURATED, TICKERS)
    links = {(l.partner, l.direction) for l in extract_links(text, index, {"SELF"})}
    assert ("AAPL", "client") in links and ("TSM", "supplier") in links and ("ZEISS", "supplier") in links
    assert ("AMKR", "supplier") in links
    assert not any(p in ("NDAQ", "MSTR", "FN") for p, _ in links)  # exchange, ordinary word, bare one-word name
