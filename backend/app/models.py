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


class ChecklistCriterion(BaseModel):
    key: str
    label: str
    rule: str
    value: float | None
    display: str | None
    passed: bool | None  # None: couldn't be evaluated (counts as not met)
    note: str | None
    value_label: str | None  # raw value, unit-formatted ("76.2%", "8/9")


class CaseStudyModel(BaseModel):
    company: str
    ticker: str | None
    period: str
    summary: str
    illustrates: list[str]  # criterion keys this episode illustrates


class LegendQuoteModel(BaseModel):
    text: str
    source: str


class AllocationModel(BaseModel):
    company: str
    ticker: str | None
    period: str
    thesis: str


class LegendContextModel(BaseModel):
    tenure: str
    approach: str
    case_study: CaseStudyModel
    quote: LegendQuoteModel | None
    rules_of_thumb: list[str]
    further_reading: list[str]
    allocations: list[AllocationModel]  # notable past positions
    metric_rationale: dict[str, str]  # criterion key → why this legend watches it


class InvestorChecklistModel(BaseModel):
    key: str  # buffett | lynch | munger | ackman
    name: str
    philosophy: str
    criteria: list[ChecklistCriterion]
    verdict: str  # worth_buying | pass
    summary: str
    context: LegendContextModel  # historical narrative behind the rules


class QuoteModel(BaseModel):
    price: float
    currency: str
    source: str
    as_of: str | None
    comparable: bool  # usable against per-share figures from the filings
    note: str | None


class ChecklistResponse(BaseModel):
    symbol: str
    entity_name: str
    fiscal_year: int | None
    period_end: str | None
    currency: str
    price: QuoteModel | None
    price_note: str | None
    investors: list[InvestorChecklistModel]


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


class CountryLeadersResponse(BaseModel):
    country: str  # ISO 3166-1 alpha-2
    list_as_of: str  # when the curated ranking was compiled
    sectors: list[str]  # display order for grouping
    leaders: list[LeaderModel]


class DiscoveryCountriesResponse(BaseModel):
    countries: dict[str, int]  # ISO alpha-2 → number of curated leaders


class GuruFocusDcfResponse(BaseModel):
    symbol: str
    status: str  # ok | na
    reason: str | None
    code: str | None  # api_key_required when an API key / paid plan is what's missing
    currency: str | None  # reporting currency of fair_value
    fair_value: float | None
    growth_stage: float | None
    terminal_stage: float | None
    tangible_book_per_share: float | None
    eps: float | None
    eps_year: int | None
    growth_rate: float | None
    growth_years: int | None
    discount_rate: float | None
    price: float | None
    price_currency: str | None
    margin_of_safety: float | None  # None when the price isn't comparable with the filings
    price_note: str | None
