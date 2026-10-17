"""Industry peer suggestions from a company's SEC Standard Industrial Classification (SIC) code.

SIC codes are too granular to use directly (Apple is 3571, Microsoft 7372, Alphabet 7370, NVIDIA 3674),
so codes map onto curated peer groups. Lookup order:
  1. ticker override — a few large companies whose SIC code misrepresents their business
  2. exact 4-digit SIC code
  3. 2-digit SIC major group (e.g. 60xx → banks)
SIC assignments below were taken from the companies' own EDGAR submissions.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.sec_client import SecEdgarClient


@dataclass(frozen=True)
class PeerGroup:
    label: str
    tickers: tuple[str, ...]  # ordered by relevance; the first few are suggested first


PEER_GROUPS: dict[str, PeerGroup] = {
    "big_tech": PeerGroup("Big Tech", ("MSFT", "GOOGL", "NVDA", "AMZN", "META", "AAPL")),
    "software": PeerGroup("Software", ("MSFT", "ORCL", "CRM", "ADBE", "INTU", "NOW", "SNOW", "PLTR")),
    "hardware": PeerGroup("Computer Hardware & Networking", ("DELL", "HPQ", "HPE", "IBM", "CSCO", "AAPL")),
    "semiconductors": PeerGroup("Semiconductors", ("NVDA", "AVGO", "AMD", "QCOM", "TXN", "INTC", "MU")),
    "internet_platforms": PeerGroup("Internet Platforms", ("UBER", "ABNB", "BKNG", "DASH", "LYFT")),
    "ecommerce": PeerGroup("E-Commerce & Retail Platforms", ("AMZN", "SHOP", "EBAY", "WMT", "COST")),
    "payments": PeerGroup("Payments & Card Networks", ("V", "MA", "PYPL", "AXP", "COF")),
    "banks": PeerGroup("Banks", ("JPM", "BAC", "WFC", "C", "USB", "PNC")),
    "capital_markets": PeerGroup("Capital Markets", ("GS", "MS", "SCHW", "BLK")),
    "managed_care": PeerGroup("Managed Care", ("UNH", "ELV", "CI", "HUM", "CVS")),
    "pharma": PeerGroup("Pharmaceuticals & Biotech", ("LLY", "JNJ", "MRK", "ABBV", "PFE", "BMY", "AMGN", "GILD")),
    "medtech": PeerGroup("Medical Devices", ("ABT", "MDT", "SYK", "BSX", "ISRG")),
    "life_science_tools": PeerGroup("Life Science Tools", ("TMO", "DHR", "A")),
    "energy": PeerGroup("Oil & Gas", ("XOM", "CVX", "COP", "EOG", "OXY", "PSX", "MPC")),
    "oilfield_services": PeerGroup("Oilfield Services", ("SLB", "HAL", "BKR")),
    "autos": PeerGroup("Automakers", ("TSLA", "F", "GM", "TM", "STLA", "RIVN")),
    "aerospace_defense": PeerGroup("Aerospace & Defense", ("BA", "LMT", "RTX", "NOC", "GD")),
    "industrials": PeerGroup("Industrial Machinery & Conglomerates", ("GE", "HON", "CAT", "DE", "MMM", "ETN")),
    "big_box_retail": PeerGroup("Big-Box & Discount Retail", ("WMT", "COST", "TGT", "DG", "DLTR", "BJ")),
    "home_improvement": PeerGroup("Home Improvement", ("HD", "LOW", "SHW")),
    "grocery_pharmacy": PeerGroup("Grocery & Pharmacy Retail", ("KR", "CVS", "WBA", "ACI")),
    "beverages": PeerGroup("Beverages", ("KO", "PEP", "KDP", "MNST")),
    "packaged_food": PeerGroup("Packaged Food", ("MDLZ", "KHC", "GIS", "HSY", "K")),
    "household_products": PeerGroup("Household & Personal Products", ("PG", "CL", "KMB", "CLX", "EL", "CHD")),
    "restaurants": PeerGroup("Restaurants", ("MCD", "SBUX", "CMG", "YUM", "DPZ")),
    "apparel": PeerGroup("Apparel & Footwear", ("NKE", "LULU", "TJX")),
    "telecom": PeerGroup("Telecom", ("T", "VZ", "TMUS")),
    "media": PeerGroup("Media & Entertainment", ("DIS", "NFLX", "CMCSA", "CHTR", "WBD")),
    "airlines": PeerGroup("Airlines", ("DAL", "UAL", "AAL", "LUV")),
    "transport": PeerGroup("Freight & Logistics", ("UPS", "FDX", "UNP", "CSX", "NSC")),
    "utilities": PeerGroup("Utilities", ("NEE", "DUK", "SO", "D", "AEP")),
    "reits": PeerGroup("REITs", ("AMT", "PLD", "EQIX", "SPG", "O")),
    "chemicals": PeerGroup("Chemicals & Materials", ("LIN", "APD", "DD", "DOW", "SHW")),
}

# Exact SIC code → peer group.
SIC_TO_GROUP: dict[str, str] = {
    # Technology
    "3571": "big_tech", "7370": "big_tech",
    "7371": "software", "7372": "software", "7373": "software", "7374": "software",
    "3570": "hardware", "3572": "hardware", "3576": "hardware", "3577": "hardware", "3661": "hardware",
    "3674": "semiconductors", "3663": "semiconductors", "3672": "semiconductors",
    "5961": "ecommerce",
    # Financials
    "7389": "payments", "6199": "payments", "6141": "payments",
    "6021": "banks", "6022": "banks", "6029": "banks",
    "6211": "capital_markets", "6282": "capital_markets",
    "6324": "managed_care",
    "6798": "reits",
    # Healthcare
    "2834": "pharma", "2835": "pharma", "2836": "pharma",
    "3841": "medtech", "3842": "medtech", "3845": "medtech",
    "3823": "life_science_tools", "3826": "life_science_tools", "3829": "life_science_tools",
    # Energy & materials
    "2911": "energy", "1311": "energy",
    "1389": "oilfield_services", "3533": "oilfield_services",
    "2800": "chemicals", "2810": "chemicals", "2821": "chemicals", "2860": "chemicals",
    # Industrials & transport
    "3711": "autos", "3714": "autos",
    "3721": "aerospace_defense", "3724": "aerospace_defense", "3728": "aerospace_defense",
    "3730": "aerospace_defense", "3760": "aerospace_defense", "3812": "aerospace_defense",
    "3600": "industrials", "3523": "industrials", "3531": "industrials",
    "4512": "airlines",
    "4011": "transport", "4210": "transport", "4513": "transport",
    # Consumer
    "5331": "big_box_retail", "5311": "big_box_retail",
    "5211": "home_improvement", "5200": "home_improvement",
    "5411": "grocery_pharmacy", "5912": "grocery_pharmacy",
    "2080": "beverages", "2086": "beverages",
    "2000": "packaged_food", "2030": "packaged_food", "2040": "packaged_food", "2060": "packaged_food",
    "2840": "household_products", "2842": "household_products", "2844": "household_products", "2670": "household_products",
    "5810": "restaurants", "5812": "restaurants",
    "3021": "apparel", "2300": "apparel", "5651": "apparel",
    # Communications & utilities
    "4812": "telecom", "4813": "telecom",
    "4841": "media", "4833": "media", "7841": "media", "7990": "media",
    "4911": "utilities", "4931": "utilities", "4932": "utilities",
}  # fmt: skip

# 2-digit SIC major group fallback, for codes not listed above.
SIC_MAJOR_GROUP_TO_GROUP: dict[str, str] = {
    "13": "energy", "29": "energy", "20": "packaged_food", "28": "chemicals",
    "45": "airlines", "48": "telecom", "49": "utilities", "58": "restaurants",
    "60": "banks", "62": "capital_markets", "63": "managed_care", "73": "software",
}  # fmt: skip

# Companies whose SIC code misrepresents their business (from their EDGAR filings).
TICKER_OVERRIDES: dict[str, str] = {
    "UBER": "internet_platforms",  # SIC 7389 (business services) — same code as Visa/PayPal
    "ABNB": "internet_platforms",  # SIC 7340 (services to dwellings)
    "MMM": "industrials",  # SIC 3841 (surgical instruments)
    "DPZ": "restaurants",  # SIC 5140 (wholesale groceries)
    "SHW": "chemicals",  # SIC 5200 (retail building materials)
    "AMZN": "big_tech",  # SIC 5961 (catalog & mail-order)
    "NVDA": "big_tech",  # SIC 3674 — also a semiconductor, but compared with mega-cap tech first
}


@dataclass(frozen=True)
class PeerMatch:
    group_key: str
    label: str
    basis: str  # "ticker" | "sic" | "sic_major_group"
    tickers: tuple[str, ...]


def match_peer_group(ticker: str | None, sic: str | None) -> PeerMatch | None:
    if ticker and ticker in TICKER_OVERRIDES:
        key, basis = TICKER_OVERRIDES[ticker], "ticker"
    elif sic and sic in SIC_TO_GROUP:
        key, basis = SIC_TO_GROUP[sic], "sic"
    elif sic and sic[:2] in SIC_MAJOR_GROUP_TO_GROUP:
        key, basis = SIC_MAJOR_GROUP_TO_GROUP[sic[:2]], "sic_major_group"
    else:
        return None
    group = PEER_GROUPS[key]
    return PeerMatch(group_key=key, label=group.label, basis=basis, tickers=group.tickers)


@dataclass(frozen=True)
class Peer:
    ticker: str
    name: str


@dataclass(frozen=True)
class PeerSuggestions:
    ticker: str | None
    sic: str | None
    sic_description: str | None
    group: str | None
    basis: str | None
    peers: list[Peer]


async def suggest_peers(client: SecEdgarClient, identifier: str, limit: int = 6) -> PeerSuggestions:
    cik = await client.resolve_cik(identifier)
    submissions = await client.get_submissions(cik)
    tickers = [t.upper() for t in submissions.get("tickers", [])]
    ticker = tickers[0] if tickers else None
    sic = str(submissions.get("sic") or "") or None
    match = match_peer_group(ticker, sic)

    peers: list[Peer] = []
    if match:
        known = await client.get_ticker_map()
        for candidate in match.tickers:
            entry = known.get(candidate)
            # Skip the company itself (any of its share classes) and anything EDGAR doesn't know.
            if candidate in tickers or entry is None or entry["cik"] == cik:
                continue
            peers.append(Peer(ticker=candidate, name=entry["title"]))
            if len(peers) >= limit:
                break

    return PeerSuggestions(
        ticker=ticker,
        sic=sic,
        sic_description=submissions.get("sicDescription") or None,
        group=match.label if match else None,
        basis=match.basis if match else None,
        peers=peers,
    )
