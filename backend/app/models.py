from datetime import datetime

from pydantic import BaseModel

from app.services.gaap_mapping import PeriodType


class Filing(BaseModel):
    form: str
    accession_number: str
    filing_date: str
    report_date: str | None
    url: str


class CompanyProfile(BaseModel):
    cik: str | None  # None for companies served by the global provider (no SEC registration)
    source: str  # "sec" | "fmp"
    symbol: str  # the symbol as requested, e.g. "ASML.AS"
    name: str
    tickers: list[str]
    exchanges: list[str]
    sic: str | None
    sic_description: str | None
    fiscal_year_end: str | None
    state_of_incorporation: str | None
    country: str | None = None  # ISO code of the listing's exchange, for international symbols
    peer_group: str | None = None  # peers.PEER_GROUPS key ("big_box_retail"…), from SIC code or ticker override
    peer_group_label: str | None = None
    recent_filings: list[Filing]


class MetricValue(BaseModel):
    value: float
    source_tag: str  # original US-GAAP tag, "ifrs-full:" tag, or FMP "statement.field" this value was mapped from
    accession_number: str | None  # EDGAR accession; None for FMP data
    form: str
    filed: str


class Ratio(BaseModel):
    value: float | None
    formula: str
    note: str | None = None


class Variance(BaseModel):
    prior_value: float
    change_pct: float | None  # signed YoY % change; None when the prior value was zero
    flagged: bool  # |change| exceeds the materiality threshold
    direction: str  # up | down | flat
    severity_tier: int | None  # 1: 10-19.9%, 2: 20-29.9%, 3: 30-39.9%, 4: ≥40% (None when not flagged)
    prior_period_end: str
    prior_fiscal_year: int | None
    prior_fiscal_period: str | None


class FinancialPeriod(BaseModel):
    start: str
    end: str
    fiscal_year: int | None
    fiscal_period: str | None
    # Keyed by Metric (income statement + closing balance sheet).
    line_items: dict[str, MetricValue | None]
    # Keyed by RatioKey.
    ratios: dict[str, Ratio | None]
    # Keyed by Metric; only line items with a prior-year comparison appear.
    variances: dict[str, Variance]
    forensics: "Forensics"


class FinancialsResponse(BaseModel):
    cik: str | None
    symbol: str
    source: str  # "sec" | "fmp"
    accounting_standard: str  # "US GAAP" | "IFRS" | "FMP standardized"
    currency: str  # ISO 4217 code of every monetary value in `periods`
    entity_name: str
    period_type: PeriodType
    variance_threshold_pct: float
    periods: list[FinancialPeriod]
    tag_map: dict[str, list[str]]


class NewsItem(BaseModel):
    title: str
    url: str
    source: str | None
    published_at: datetime | None


class NewsResponse(BaseModel):
    ticker: str
    provider: str
    items: list[NewsItem]


class NarrativeBullet(BaseModel):
    theme: str  # operational_headwind | supply_chain | forward_risk
    headline: str
    detail: str
    evidence_quote: str
    quote_verified: bool


class NarrativeResponse(BaseModel):
    entity_name: str
    filing: Filing
    mdna_chars: int
    model: str
    bullets: list[NarrativeBullet]


class ForensicSignal(BaseModel):
    key: str
    label: str
    passed: bool | None


class PiotroskiScore(BaseModel):
    score: int | None  # 0-9; None when fewer than 7 signals could be evaluated
    available: int
    signals: list[ForensicSignal]


class ScoredValue(BaseModel):
    value: float | None
    zone: str | None  # altman: safe | grey | distress; sloan: low | normal | high
    note: str | None = None


class Forensics(BaseModel):
    piotroski: PiotroskiScore | None
    altman_z: ScoredValue | None
    sloan_accruals_pct: ScoredValue | None
    note: str | None = None


class PeerItem(BaseModel):
    ticker: str
    name: str


class PeersResponse(BaseModel):
    ticker: str | None
    sic: str | None
    sic_description: str | None
    group: str | None  # curated peer-group label, e.g. "Big Tech"
    basis: str | None  # how the group was chosen: ticker | sic | sic_major_group
    peers: list[PeerItem]


class RateModel(BaseModel):
    value: float  # decimal: 0.051 = 5.10%
    as_of: str
    source: str


class SectorBetaModel(BaseModel):
    beta: float
    unlevered_beta: float
    industries: list[str]


class MacroFactorsResponse(BaseModel):
    risk_free_rate: RateModel  # 10-year US Treasury
    equity_risk_premium: RateModel
    sector_betas: dict[str, SectorBetaModel]
    sector_betas_source: str
    updated_at: str
    aaa_yield: RateModel | None = None  # Moody's Aaa corporate yield (Graham's "Y")


class QuoteModel(BaseModel):
    price: float
    currency: str
    source: str
    as_of: str | None
    comparable: bool  # usable against per-share figures from the filings
    note: str | None


class BetaChoiceModel(BaseModel):
    value: float
    group_key: str
    group_label: str
    basis: str
    source: str


class ValuationInputsResponse(BaseModel):
    symbol: str
    currency: str  # reporting currency of the filings
    price: QuoteModel | None
    price_note: str | None
    beta: BetaChoiceModel
    risk_free_rate: RateModel
    equity_risk_premium: RateModel
    aaa_yield: RateModel | None = None  # Moody's Aaa corporate yield (Graham's "Y")


class SnapshotModel(BaseModel):
    name: str | None
    exchange: str | None
    price: float
    currency: str
    change_pct: float | None
    week52_low: float | None
    week52_high: float | None
    source: str


class LeaderModel(BaseModel):
    rank: int
    symbol: str
    name: str
    sector: str
    snapshot: SnapshotModel | None  # None when no live quote was available
    coverage: str  # sec | fmp | fmp_key_required | unavailable
    market_cap: float | None = None  # in the listing's price currency
    market_cap_usd: float | None = None  # for ranking across currencies


class CountryLeadersResponse(BaseModel):
    country: str  # ISO 3166-1 alpha-2
    list_as_of: str  # when the curated ranking was compiled
    sectors: list[str]  # display order for grouping
    leaders: list[LeaderModel]


class DiscoveryCountriesResponse(BaseModel):
    countries: dict[str, int]  # ISO alpha-2 → number of curated leaders


class BasisInputModel(BaseModel):
    key: str  # eps | fcf | dividend
    label: str
    value: float | None  # per share, in DcfInputsResponse.currency
    period: str | None
    is_ttm: bool
    h10: float | None  # historical growth, percent per year
    h10_years: int | None  # span measured: 10, else 5 or 3
    h10_note: str | None


class DcfInputsResponse(BaseModel):
    symbol: str
    name: str
    source: str
    currency: str  # of every per-share figure (the price's currency after any FX conversion)
    reporting_currency: str
    fx_rate: float | None
    price: float | None
    price_source: str | None
    price_as_of: str | None
    price_comparable: bool
    price_note: str | None
    bases: list[BasisInputModel]
    tbv: float | None
    tbv_as_of: str | None
    shares: float | None
    t10: float  # percent
    t10_as_of: str
    t10_source: str
    predictability: float | None  # 0–5; None = no source
    missing: list[str]  # inputs the data sources can't provide, and what's used instead


class LiveQuoteResponse(BaseModel):
    symbol: str
    price: float
    currency: str
    source: str
    as_of: str | None


class SupplyChainNodeModel(BaseModel):
    id: str
    name: str
    public: bool
    ticker: str | None  # loadable symbol for public companies; None for private ones
    role: str  # focus | supplier | client | both
    mentions: list[str]  # names used for it in other companies' filings


class SupplyChainEdgeModel(BaseModel):
    source: str  # supplier
    target: str  # client
    type: str  # supplier (into the focus company) | client (out of it) | peer
    product: str | None
    revenue_pct: float | None  # client's share of the supplier's revenue, when disclosed
    major: bool  # disclosed ≥10% customer
    source_note: str | None
    origin: str  # curated | filing
    evidence: str | None  # filing sentence behind a 'filing' link


class CoveredCompanyModel(BaseModel):
    id: str
    name: str


class SupplyChainResponse(BaseModel):
    focus: str
    nodes: list[SupplyChainNodeModel]
    edges: list[SupplyChainEdgeModel]
    covered: list[CoveredCompanyModel]  # companies with mapped relationships, for exploring
    filing: dict[str, str] | None  # annual report read for this web (form, filed, url)
    filing_status: str


class FilingNoteModel(BaseModel):
    company: str
    form: str
    accession: str
    filed: str
    url: str
    excerpts: list[str]  # verbatim sentences from the filing that name the partner
    figures: list[str]  # percentages / dollar amounts appearing in those sentences
    fingerprint: str
    as_of: str
    updated_from: str | None
    checked_accession: str | None
    latest_names_partner: bool  # False when only an earlier report names the partner


class SideContextModel(BaseModel):
    company: str
    name: str
    public: bool
    has_filings: bool
    note: FilingNoteModel | None
    status: str


class RelationshipContextModel(BaseModel):
    supplier: SideContextModel
    client: SideContextModel
    product: str | None
    major: bool
    revenue_pct: float | None
    source_note: str | None
    summary: str
    notes_updated: list[str]
