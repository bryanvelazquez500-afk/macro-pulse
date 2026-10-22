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

/** Extracted for models (ROIC, SG&A, DDM, EPS) but not shown as matrix rows. `net_income_common` is the GAAP EPS
 * numerator: net income available to common shareholders, after preferred dividends. */
export type HelperMetricKey = "pretax_income" | "income_tax_expense" | "sga_expense" | "dividends_paid" | "goodwill_and_intangibles" | "net_income_common";

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
  /** Set when figures were converted for display (lib/fx.tsx): the currency the filings report in. */
  converted_from?: string;
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

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.detail ?? `Request failed (${res.status})`, res.status, body?.code ?? null);
  }
  return res.json();
}

// ── request cache ───────────────────────────────────────────────────────────
// GETs are shared and remembered for a few minutes: two panels asking for the same data make one request,
// and switching tabs, refocusing a column or re-adding a company is instant. Requests the page started
// early (EARLY_FETCH_SCRIPT, in <head>, before React loads) are adopted rather than repeated.

declare global {
  interface Window {
    __mpEarly?: Record<string, Promise<Response>>;
  }
}

const memo = new Map<string, { at: number; promise: Promise<unknown> }>();
const ttlMs = (path: string) => (path.includes("/quotes/") ? 30_000 : path.includes("/news") ? 120_000 : 5 * 60_000);

function load(path: string): Promise<unknown> {
  const early = typeof window === "undefined" ? undefined : window.__mpEarly?.[path];
  if (early) delete window.__mpEarly![path];
  return (early ?? fetch(`${API_URL}${path}`)).then(parse);
}

/** Resolve with `promise`, but reject this caller (only) when its signal aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function getJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  if (init && (init.method ?? "GET").toUpperCase() !== "GET") {
    // Writes go straight through, and anything they may have changed is fetched fresh afterwards.
    const result = await parse<T>(await fetch(`${API_URL}${path}`, { signal, ...init }));
    memo.clear();
    return result;
  }
  const hit = memo.get(path);
  let promise = hit && Date.now() - hit.at < ttlMs(path) ? hit.promise : undefined;
  if (!promise) {
    const fresh = load(path);
    promise = fresh;
    memo.set(path, { at: Date.now(), promise: fresh });
    fresh.catch(() => memo.get(path)?.promise === fresh && memo.delete(path)); // never remember failures
  }
  return abortable(promise as Promise<T>, signal);
}

/** Start the requests a newly added company will need, so its tabs open with data already here. */
export function warmCompany(id: string) {
  const c = `/api/companies/${encodeURIComponent(id)}`;
  for (const path of [`${c}/peers?limit=6`, `${c}/news?limit=10`, `${c}/valuation-inputs`, `${c}/dcf-inputs`]) {
    getJson(path).catch(() => {}); // errors surface later, in the panel that asks
  }
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

/** A share price plus whether it can be compared with the filings' per-share figures. */
export interface PriceQuote {
  price: number;
  currency: string;
  source: string;
  as_of: string | null;
  comparable: boolean;
  note: string | null;
}

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
  /** Moody's Aaa corporate bond yield — Graham's "Y". */
  aaa_yield?: Rate | null;
}

export interface ValuationInputs {
  symbol: string;
  /** Reporting currency of the filings. */
  currency: string;
  price: PriceQuote | null;
  price_note: string | null;
  beta: { value: number; group_key: string; group_label: string; basis: string; source: string };
  risk_free_rate: Rate;
  equity_risk_premium: Rate;
  /** Moody's Aaa corporate bond yield — Graham's "Y". */
  aaa_yield?: Rate | null;
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
  /** Live market cap in the listing's price currency (price × SEC shares outstanding); null when unknown. */
  market_cap: number | null;
  market_cap_usd: number | null;
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

export type DcfBasisKey = "eps" | "fcf" | "dividend";

export interface DcfBasisInput {
  key: DcfBasisKey;
  label: string;
  /** Per share, in DcfInputs.currency. */
  value: number | null;
  period: string | null;
  is_ttm: boolean;
  /** Historical growth, percent per year (10-year, else 5 or 3 — see h10_years). */
  h10: number | null;
  h10_years: number | null;
  h10_note: string | null;
}

/** Live inputs for the DCF calculator, from the existing SEC / FMP pipelines plus quotes and macro rates. */
export interface DcfInputs {
  symbol: string;
  name: string;
  source: string;
  /** Currency of every per-share figure (the price's, after any FX conversion). */
  currency: string;
  reporting_currency: string;
  fx_rate: number | null;
  price: number | null;
  price_source: string | null;
  price_as_of: string | null;
  price_comparable: boolean;
  price_note: string | null;
  bases: DcfBasisInput[];
  tbv: number | null;
  tbv_as_of: string | null;
  shares: number | null;
  /** 10-year Treasury yield, percent. */
  t10: number;
  t10_as_of: string;
  t10_source: string;
  /** 0–5 stars; null when no source provides it. */
  predictability: number | null;
  /** Inputs the data sources can't provide, and what's used instead. */
  missing: string[];
}

export const fetchDcfInputs = (id: string, signal?: AbortSignal) =>
  getJson<DcfInputs>(`/api/companies/${encodeURIComponent(id)}/dcf-inputs`, signal);

export interface LiveQuote {
  symbol: string;
  price: number;
  currency: string;
  source: string;
  as_of: string | null;
}

export const fetchLiveQuote = (symbol: string, signal?: AbortSignal) =>
  getJson<LiveQuote>(`/api/quotes/${encodeURIComponent(symbol)}`, signal);


export interface SupplyChainNode {
  id: string;
  name: string;
  public: boolean;
  /** Loadable symbol for public companies; null for private ones. */
  ticker: string | null;
  role: "focus" | "supplier" | "client" | "both";
  /** Names used for it in other companies' filings. */
  mentions: string[];
}

export interface SupplyChainEdge {
  /** Supplier id. */
  source: string;
  /** Client id. */
  target: string;
  /** "supplier": into the focus company · "client": out of it · "peer": between its partners. */
  type: "supplier" | "client" | "peer";
  product: string | null;
  /** The client's share of the supplier's revenue, when the supplier discloses it. */
  revenue_pct: number | null;
  /** Disclosed ≥10% customer. */
  major: boolean;
  source_note: string | null;
  /** "curated": from the relationship file · "filing": named in the focus company's latest annual report. */
  origin: "curated" | "filing";
  /** The filing sentence a "filing" link was read from. */
  evidence: string | null;
}

export interface SupplyChainGraph {
  focus: string;
  nodes: SupplyChainNode[];
  edges: SupplyChainEdge[];
  /** Companies with mapped relationships, for exploring. */
  covered: { id: string; name: string }[];
  /** The annual report read for this web, when the company files with the SEC. */
  filing: { form: string; filed: string; url: string } | null;
  /** Why no report was read, when none was. */
  filing_status: string;
}

export const fetchSupplyChain = (id: string, signal?: AbortSignal) =>
  getJson<SupplyChainGraph>(`/api/companies/${encodeURIComponent(id)}/supply-chain`, signal);

export interface FilingNote {
  company: string;
  form: string;
  accession: string;
  filed: string;
  url: string;
  /** Verbatim sentences from the filing that name the partner. */
  excerpts: string[];
  /** Percentages / dollar amounts appearing in those sentences — nothing else. */
  figures: string[];
  fingerprint: string;
  /** When this content was first recorded. */
  as_of: string;
  /** Accession of the filing whose content this replaced, when a newer filing said something new. */
  updated_from: string | null;
  checked_accession: string | null;
  /** False when only an earlier annual report names the partner. */
  latest_names_partner: boolean;
}

export interface RelationshipSide {
  company: string;
  name: string;
  public: boolean;
  has_filings: boolean;
  note: FilingNote | null;
  status: string;
}

export interface RelationshipContext {
  supplier: RelationshipSide;
  client: RelationshipSide;
  product: string | null;
  major: boolean;
  revenue_pct: number | null;
  source_note: string | null;
  summary: string;
  notes_updated: string[];
}

export const fetchRelationship = (supplier: string, client: string, signal?: AbortSignal) =>
  getJson<RelationshipContext>(
    `/api/supply-chain/relationship?supplier=${encodeURIComponent(supplier)}&client=${encodeURIComponent(client)}`,
    signal,
  );

// ── currency conversion ─────────────────────────────────────────────────────

export interface FxRate {
  currency: string;
  usd_per_unit: number;
  as_of: string;
  source: string;
}

/** Live USD value of one unit of `currency` (cached 10 minutes server-side). */
export const fetchFxRate = (currency: string, signal?: AbortSignal) => getJson<FxRate>(`/api/fx/${encodeURIComponent(currency)}`, signal);

// ── filing reactions (historical event study) ───────────────────────────────

export interface ReactionFundamentals {
  period_label: string | null;
  revenue: number | null;
  revenue_yoy: number | null;
  net_income_yoy: number | null;
  eps: number | null;
  eps_yoy: number | null;
}

export interface ReactionEvent {
  report_form: string;
  report_filed: string;
  report_url: string;
  period_end: string | null;
  event_form: string;
  event_accepted_et: string;
  event_url: string;
  session: "before open" | "during market" | "after close";
  reaction_date: string | null;
  prior_close: number | null;
  close_1d: number | null;
  ret_1d: number | null;
  ret_3d: number | null;
  ret_5d: number | null;
  mkt_1d: number | null;
  mkt_5d: number | null;
  beta: number | null;
  abn_1d: number | null;
  abn_3d: number | null;
  abn_5d: number | null;
  pre_5d_abn: number | null;
  sigma: number | null;
  z_1d: number | null;
  fundamentals: ReactionFundamentals;
  nuances: { code: string; text: string }[];
  summary: string;
}

export interface FilingReactions {
  symbol: string;
  company: string | null;
  market: string;
  prices: { d: string; c: number }[];
  events: ReactionEvent[];
  notes: string[];
}

export const fetchFilingReactions = (id: string, years: number, signal?: AbortSignal) =>
  getJson<FilingReactions>(`/api/companies/${encodeURIComponent(id)}/filing-reactions?years=${years}`, signal);
