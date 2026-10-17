/**
 * Base URL of the Python API. Set NEXT_PUBLIC_API_URL per environment (e.g. https://api.macropulse.example);
 * unset or empty falls back to the local backend. NEXT_PUBLIC_ values are inlined at build time, so set it
 * before `next build`, not only at runtime. A trailing slash is ignored.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");

export type PeriodType = "annual" | "quarterly";

export type IncomeStatementKey = "revenue" | "cost_of_goods_sold" | "operating_income" | "net_income" | "diluted_shares";

export type CashFlowKey = "operating_cash_flow" | "capital_expenditures" | "free_cash_flow";

export type BalanceSheetKey =
  | "cash_and_equivalents"
  | "short_term_investments"
  | "accounts_receivable"
  | "inventory"
  | "current_assets"
  | "total_assets"
  | "current_liabilities"
  | "total_liabilities"
  | "stockholders_equity"
  | "retained_earnings"
  | "long_term_debt";

export type MetricKey = IncomeStatementKey | CashFlowKey | BalanceSheetKey;

/** Extracted for models (ROIC, SG&A, DDM) but not shown as matrix rows. */
export type HelperMetricKey = "pretax_income" | "income_tax_expense" | "sga_expense" | "dividends_paid" | "goodwill_and_intangibles";

export type RatioKey =
  | "current_ratio"
  | "quick_ratio"
  | "debt_to_equity"
  | "gross_margin_pct"
  | "operating_margin_pct"
  | "net_margin_pct"
  | "asset_turnover";

export interface MetricValue {
  value: number;
  /** US-GAAP tag (bare), "ifrs-full:" tag, or FMP "statement.field". */
  source_tag: string;
  /** EDGAR accession; null for Financial Modeling Prep data. */
  accession_number: string | null;
  form: string;
  filed: string;
}

export interface Ratio {
  value: number | null;
  formula: string;
  note: string | null;
}

export interface Variance {
  prior_value: number;
  /** Signed YoY % change; null when the prior value was zero. */
  change_pct: number | null;
  flagged: boolean;
  direction: "up" | "down" | "flat";
  /** 1: 10–19.9%, 2: 20–29.9%, 3: 30–39.9%, 4: ≥40% (null when not flagged). */
  severity_tier: 1 | 2 | 3 | 4 | null;
  prior_period_end: string;
  prior_fiscal_year: number | null;
  prior_fiscal_period: string | null;
}

export interface FinancialPeriod {
  start: string;
  end: string;
  fiscal_year: number | null;
  fiscal_period: string | null;
  line_items: Record<MetricKey, MetricValue | null> & Partial<Record<HelperMetricKey, MetricValue | null>>;
  ratios: Record<RatioKey, Ratio | null>;
  variances: Partial<Record<MetricKey, Variance>>;
  forensics: Forensics;
}

export interface ForensicSignal {
  key: string;
  label: string;
  passed: boolean | null;
}

export interface ScoredValue {
  value: number | null;
  zone: string | null;
  note: string | null;
}

export interface Forensics {
  piotroski: { score: number | null; available: number; signals: ForensicSignal[] } | null;
  /** zone: safe | grey | distress */
  altman_z: ScoredValue | null;
  /** zone: low | normal | high */
  sloan_accruals_pct: ScoredValue | null;
  note: string | null;
}

export type DataSource = "sec" | "fmp";

export interface FinancialsResponse {
  /** Null for companies served by Financial Modeling Prep (no SEC registration). */
  cik: string | null;
  symbol: string;
  source: DataSource;
  accounting_standard: string;
  /** ISO 4217 code of every monetary value in `periods`. */
  currency: string;
  entity_name: string;
  period_type: PeriodType;
  variance_threshold_pct: number;
  periods: FinancialPeriod[];
  tag_map: Record<MetricKey, string[]>;
}

export interface Filing {
  form: string;
  accession_number: string;
  filing_date: string;
  report_date: string | null;
  url: string;
}

export interface CompanyProfile {
  cik: string | null;
  source: DataSource;
  /** The symbol as requested, e.g. "ASML.AS". */
  symbol: string;
  country: string | null;
  /** peers.PEER_GROUPS key (e.g. "big_box_retail"), when the SEC industry code maps to one. */
  peer_group: string | null;
  peer_group_label: string | null;
  name: string;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sic_description: string | null;
  fiscal_year_end: string | null;
  state_of_incorporation: string | null;
  recent_filings: Filing[];
}

/** Error from the API, keeping the machine-readable `code` (e.g. "api_key_required"). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const API_KEY_REQUIRED = "api_key_required";

/** True when data is missing only because the backend lacks an API key / paid plan. */
export function needsApiKey(error: unknown): boolean {
  return error instanceof ApiError && error.code === API_KEY_REQUIRED;
}

async function getJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.detail ?? `Request failed (${res.status})`, res.status, body?.code ?? null);
  }
  return res.json();
}

export const fetchProfile = (id: string) => getJson<CompanyProfile>(`/api/companies/${encodeURIComponent(id)}`);

export const fetchFinancials = (id: string, period: PeriodType, limit = 10) =>
  getJson<FinancialsResponse>(`/api/companies/${encodeURIComponent(id)}/financials?period=${period}&limit=${limit}`);

export interface NewsItem {
  title: string;
  url: string;
  source: string | null;
  published_at: string | null;
}

export interface NewsResponse {
  ticker: string;
  provider: string;
  items: NewsItem[];
}

export const fetchNews = (id: string, signal?: AbortSignal) =>
  getJson<NewsResponse>(`/api/companies/${encodeURIComponent(id)}/news?limit=10`, signal);

export interface PeersResponse {
  ticker: string | null;
  sic: string | null;
  sic_description: string | null;
  group: string | null;
  basis: "ticker" | "sic" | "sic_major_group" | null;
  peers: { ticker: string; name: string }[];
}

export const fetchPeers = (id: string, signal?: AbortSignal) =>
  getJson<PeersResponse>(`/api/companies/${encodeURIComponent(id)}/peers?limit=6`, signal);

export type ChecklistVerdict = "worth_buying" | "pass";

export interface ChecklistCriterion {
  key: string;
  label: string;
  /** Threshold in words, e.g. "> 15%". */
  rule: string;
  value: number | null;
  display: string | null;
  /** null: couldn't be evaluated — counts as not met. */
  passed: boolean | null;
  note: string | null;
  /** Raw value, unit-formatted: "76.2%", "8/9", "1.06×". */
  value_label: string | null;
}

export interface LegendContext {
  tenure: string;
  approach: string;
  case_study: {
    company: string;
    ticker: string | null;
    period: string;
    summary: string;
    /** Keys of this legend's criteria the episode illustrates. */
    illustrates: string[];
  };
  quote: { text: string; source: string } | null;
  rules_of_thumb: string[];
  further_reading: string[];
  /** Notable past positions. */
  allocations: { company: string; ticker: string | null; period: string; thesis: string }[];
  /** Criterion key → why this legend watches it. */
  metric_rationale: Record<string, string>;
}

export interface InvestorChecklist {
  key: "buffett" | "lynch" | "munger" | "ackman";
  name: string;
  philosophy: string;
  criteria: ChecklistCriterion[];
  verdict: ChecklistVerdict;
  summary: string;
  /** Historical narrative behind the rules. */
  context: LegendContext;
}

export interface ChecklistResponse {
  symbol: string;
  entity_name: string;
  fiscal_year: number | null;
  period_end: string | null;
  currency: string;
  price: { price: number; currency: string; source: string; as_of: string | null; comparable: boolean; note: string | null } | null;
  price_note: string | null;
  investors: InvestorChecklist[];
}

export const fetchChecklist = (id: string, signal?: AbortSignal) =>
  getJson<ChecklistResponse>(`/api/companies/${encodeURIComponent(id)}/checklist`, signal);

export interface Rate {
  /** Decimal: 0.051 = 5.10%. */
  value: number;
  as_of: string;
  source: string;
}

export interface MacroFactors {
  risk_free_rate: Rate;
  equity_risk_premium: Rate;
  sector_betas: Record<string, { beta: number; unlevered_beta: number; industries: string[] }>;
  sector_betas_source: string;
  updated_at: string;
}

export interface ValuationInputs {
  symbol: string;
  /** Reporting currency of the filings. */
  currency: string;
  price: ChecklistResponse["price"];
  price_note: string | null;
  beta: { value: number; group_key: string; group_label: string; basis: string; source: string };
  risk_free_rate: Rate;
  equity_risk_premium: Rate;
}

export const fetchValuationInputs = (id: string, signal?: AbortSignal) =>
  getJson<ValuationInputs>(`/api/companies/${encodeURIComponent(id)}/valuation-inputs`, signal);

/** Fetches the live 10-year Treasury yield on the server and overwrites the cached risk-free rate. */
export const syncMacroFactors = (signal?: AbortSignal) => getJson<MacroFactors>("/api/macro/sync", signal, { method: "POST" });

export type Coverage = "sec" | "fmp" | "fmp_key_required" | "unavailable";

export interface Leader {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  snapshot: {
    name: string | null;
    exchange: string | null;
    price: number;
    currency: string;
    change_pct: number | null;
    week52_low: number | null;
    week52_high: number | null;
    source: string;
  } | null;
  coverage: Coverage;
}

export interface CountryLeaders {
  country: string;
  list_as_of: string;
  /** Display order for sector groups. */
  sectors: string[];
  leaders: Leader[];
}

export const fetchDiscoveryCountries = (signal?: AbortSignal) =>
  getJson<{ countries: Record<string, number> }>("/api/discovery/countries", signal);

export const fetchCountryLeaders = (iso2: string, signal?: AbortSignal) =>
  getJson<CountryLeaders>(`/api/discovery/countries/${encodeURIComponent(iso2)}`, signal);

export interface GuruFocusDcf {
  symbol: string;
  status: "ok" | "na";
  reason: string | null;
  /** "api_key_required" when an API key / paid plan is what's missing. */
  code: string | null;
  /** Reporting currency of fair_value. */
  currency: string | null;
  fair_value: number | null;
  growth_stage: number | null;
  terminal_stage: number | null;
  tangible_book_per_share: number | null;
  eps: number | null;
  eps_year: number | null;
  growth_rate: number | null;
  growth_years: number | null;
  discount_rate: number | null;
  price: number | null;
  price_currency: string | null;
  /** (fair value − price) ÷ fair value; null when the price isn't comparable with the filings. */
  margin_of_safety: number | null;
  price_note: string | null;
}

export const fetchGuruFocusDcf = (id: string, signal?: AbortSignal) =>
  getJson<GuruFocusDcf>(`/api/companies/${encodeURIComponent(id)}/gurufocus-dcf`, signal);
