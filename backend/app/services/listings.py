"""International listings: exchange suffixes (ASML.AS, VOD.L, 7203.T) and their SEC registrants.

Symbols follow the Yahoo/FMP convention: `<local symbol>.<exchange suffix>`. A bare symbol, or one
whose dot is a US share class (BRK.B), is a US listing and stays on the SEC pipeline.

Many large foreign companies also file 20-F/40-F annual reports with the SEC (with XBRL facts in IFRS
or US GAAP), which is free, official and complete. `SEC_REGISTRANT_FOR_LISTING` maps a home-market
listing to its SEC ticker when the symbols differ (Sanofi is SAN.PA at home but SNY on EDGAR); when
they match (VOD.L → VOD), the router still checks the EDGAR registrant is from the exchange's
country, so LVMH (MC.PA) isn't mistaken for Moelis & Co (MC).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Exchange:
    suffix: str
    name: str
    country: str  # ISO 3166 alpha-2
    # EDGAR state/country codes (stateOfIncorporation / business address) of companies based there.
    # Only codes confirmed against real EDGAR filers are listed — an unknown code never matches,
    # which sends the listing to the global data provider instead of guessing.
    edgar_codes: frozenset[str]


_CANADA = frozenset({"A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B0", "Z4"})


def _ex(suffix: str, name: str, country: str, *codes: str) -> Exchange:
    return Exchange(suffix, name, country, frozenset(codes))


EXCHANGES: dict[str, Exchange] = {
    e.suffix: e
    for e in (
        _ex("AS", "Euronext Amsterdam", "NL", "P7"),
        _ex("PA", "Euronext Paris", "FR", "I0"),
        _ex("BR", "Euronext Brussels", "BE", "C9"),
        _ex("LS", "Euronext Lisbon", "PT"),
        _ex("IR", "Euronext Dublin", "IE", "L2"),
        _ex("MI", "Borsa Italiana", "IT", "L6"),
        _ex("L", "London Stock Exchange", "GB", "X0"),
        _ex("DE", "Deutsche Börse Xetra", "DE", "2M"),
        _ex("F", "Frankfurt Stock Exchange", "DE", "2M"),
        _ex("SW", "SIX Swiss Exchange", "CH", "V8"),
        _ex("MC", "Bolsa de Madrid", "ES", "U3"),
        _ex("ST", "Nasdaq Stockholm", "SE", "V7"),
        _ex("CO", "Nasdaq Copenhagen", "DK", "G7"),
        _ex("HE", "Nasdaq Helsinki", "FI", "H9"),
        _ex("OL", "Oslo Børs", "NO", "Q8"),
        _ex("VI", "Wiener Börse", "AT"),
        _ex("T", "Tokyo Stock Exchange", "JP", "M0"),
        _ex("HK", "Hong Kong Stock Exchange", "HK", "K3", "F4", "E9"),
        _ex("SS", "Shanghai Stock Exchange", "CN", "F4"),
        _ex("SZ", "Shenzhen Stock Exchange", "CN", "F4"),
        _ex("TW", "Taiwan Stock Exchange", "TW", "F5"),
        _ex("KS", "Korea Exchange", "KR", "M5"),
        _ex("NS", "National Stock Exchange of India", "IN", "K7"),
        _ex("BO", "BSE India", "IN", "K7"),
        _ex("AX", "Australian Securities Exchange", "AU", "C3"),
        _ex("NZ", "NZX", "NZ"),
        _ex("SI", "Singapore Exchange", "SG"),
        _ex("TA", "Tel Aviv Stock Exchange", "IL", "L3"),
        _ex("JO", "Johannesburg Stock Exchange", "ZA", "T3"),
        _ex("SA", "B3 (Brazil)", "BR", "D5"),
        _ex("MX", "Bolsa Mexicana de Valores", "MX", "O5"),
        _ex("SR", "Saudi Exchange (Tadawul)", "SA"),
        Exchange("TO", "Toronto Stock Exchange", "CA", _CANADA),
        Exchange("V", "TSX Venture Exchange", "CA", _CANADA),
        Exchange("NE", "Cboe Canada", "CA", _CANADA),
    )
}

# Home-market listing → SEC ticker, for SEC registrants whose EDGAR ticker differs from the local one,
# plus a few where the local and US companies would otherwise fail the country check (e.g. Shopify,
# Enbridge file 10-Ks). Each was checked against EDGAR's company_tickers.json.
SEC_REGISTRANT_FOR_LISTING: dict[str, str] = {
    "SAN.PA": "SNY",  # Sanofi (SAN on EDGAR is Banco Santander)
    "NOVO-B.CO": "NVO",
    "7203.T": "TM",
    "6758.T": "SONY",
    "7267.T": "HMC",
    "8306.T": "MUFG",
    "2330.TW": "TSM",
    "SHEL.L": "SHEL",  # incorporated under EDGAR code DC, which the UK country check wouldn't accept
    "ULVR.L": "UL",
    "DGE.L": "DEO",
    "HSBA.L": "HSBC",
    "BARC.L": "BCS",
    "NG.L": "NGG",
    "LLOY.L": "LYG",
    "BATS.L": "BTI",
    "NOVN.SW": "NVS",
    "UBSG.SW": "UBS",
    "INGA.AS": "ING",
    "PHIA.AS": "PHG",
    "STLAM.MI": "STLA",
    "ENI.MI": "E",
    "ABI.BR": "BUD",
    "ERIC-B.ST": "ERIC",
    "NOKIA.HE": "NOK",
    "SHOP.TO": "SHOP",
    "ENB.TO": "ENB",
}


@dataclass(frozen=True)
class Listing:
    symbol: str  # full symbol as requested, upper-cased: "ASML.AS"
    local_symbol: str  # "ASML"
    exchange: Exchange


def parse_listing(identifier: str) -> Listing | None:
    """The international listing an identifier names, or None for US tickers and CIKs."""
    symbol = identifier.strip().upper()
    local, dot, suffix = symbol.rpartition(".")
    if not dot or not local:
        return None
    exchange = EXCHANGES.get(suffix)
    # A one-letter suffix is a US share class (BRK.B) unless it's a known exchange (VOD.L, 7203.T).
    if exchange is None:
        return None
    return Listing(symbol=symbol, local_symbol=local, exchange=exchange)


def sec_ticker_candidate(listing: Listing) -> tuple[str, bool] | None:
    """(EDGAR ticker to try, whether the mapping is curated) — curated mappings skip the country check."""
    if listing.symbol in SEC_REGISTRANT_FOR_LISTING:
        return SEC_REGISTRANT_FOR_LISTING[listing.symbol], True
    if listing.local_symbol.replace("-", "").isdigit():
        return None  # numeric local codes (Tokyo, Hong Kong) never match an EDGAR ticker
    return listing.local_symbol.replace(".", "-"), False
