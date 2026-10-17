/**
 * Intrinsic Valuation Station models. All rates are decimals (0.051 = 5.1%) except where noted.
 *
 *   CAPM          k_e  = r_f + β × ERP                                    → the discount rate for DCF and DDM
 *   Multi-stage   FCF_0 = latest revenue × 3-year pooled FCF margin       (normalized base year)
 *   DCF           stage 1, t = 1…5:   FCF_t = FCF_0 × (1 + g)^t × (m / m_0)   (growth & margin sliders)
 *                 stage 2, t = 6…10:  growth fades linearly from g to g_T
 *                 stage 3:            TV = FCF_10 × (1 + g_T) ÷ (k_e − g_T)
 *                 Equity value = Σ FCF_t ÷ (1 + k_e)^t + TV ÷ (1 + k_e)^10;  per share ÷ diluted shares
 *                 Enterprise value = equity value + long-term debt − cash & short-term investments
 *   Gordon DDM    Value/share = D_0 × (1 + g_d) ÷ (k_e − g_d)
 *   Graham        Value/share = EPS × (8.5 + 2g) × 4.4 ÷ Y             (g and Y in percent; Y = r_f here)
 *   Margin of safety = (intrinsic − price) ÷ intrinsic
 *
 * FCF here is operating cash flow − capex: cash left after interest, i.e. what's available to
 * shareholders, which is why it is discounted at the cost of equity and needs no net-debt bridge.
 * Every model returns either a value or the reason it isn't meaningful for this company.
 *
 * Audit notes (Oct 2026): the base year is normalized because one year's capex can swing FCF by a
 * third — Microsoft's FY2026 AI build-out ($115.9B capex, 63% of operating cash flow) cut its FCF
 * margin to 20% vs. 25–33% before, and compounding that trough suppressed the value ~18%. Growth
 * fades over years 6–10 instead of dropping straight from g to g_T, which understated growers.
 */

import type { FinancialPeriod } from "@/lib/api";
import { PROJECTION_YEARS, TERMINAL_GROWTH_PCT } from "@/lib/valuation";

/** Used only if the backend's macro-factor cache can't be reached. */
export const FALLBACK_RISK_FREE_RATE = 0.0415;

export type ModelResult = { ok: true; value: number; detail: string } | { ok: false; reason: string };

const fail = (reason: string): ModelResult => ({ ok: false, reason });

function val(p: FinancialPeriod | undefined, key: keyof FinancialPeriod["line_items"]): number | null {
  return p?.line_items[key]?.value ?? null;
}

export function capm(riskFree: number, beta: number, erp: number): number {
  return riskFree + beta * erp;
}

/** Latest fiscal year's per-share inputs from the SEC statements (newest period first). */
export interface StatementInputs {
  fiscalYear: number | null;
  revenue: number | null;
  fcf: number | null;
  /** Σ FCF ÷ Σ revenue over the last three fiscal years with both. */
  fcfMarginPooled: number | null;
  /** Base-year FCF for the DCF: latest revenue × pooled FCF margin (falls back to the latest FCF). */
  normalizedFcf: number | null;
  longTermDebt: number | null;
  cashAndInvestments: number | null;
  operatingMarginPct: number | null;
  shares: number | null;
  eps: number | null;
  dividendPerShare: number | null;
  /** Diluted-share-based DPS growth over up to five years; null without ≥3 years of dividends. */
  dividendCagr: number | null;
}

export function statementInputs(annual: FinancialPeriod[]): StatementInputs {
  const latest = annual[0];
  const shares = val(latest, "diluted_shares");
  const revenue = val(latest, "revenue");
  const opIncome = val(latest, "operating_income");
  const netIncome = val(latest, "net_income");
  const dividends = val(latest, "dividends_paid");
  const dps = (p: FinancialPeriod) => {
    const d = val(p, "dividends_paid");
    const s = val(p, "diluted_shares");
    return d != null && d > 0 && s ? d / s : null;
  };

  const history = annual.slice(0, 5).filter((p) => dps(p) != null && p.fiscal_year != null);
  let dividendCagr: number | null = null;
  if (history.length >= 3) {
    const [newest, oldest] = [history[0], history[history.length - 1]];
    const years = newest.fiscal_year! - oldest.fiscal_year!;
    if (years > 0) dividendCagr = (dps(newest)! / dps(oldest)!) ** (1 / years) - 1;
  }

  const pooled = annual.filter((p) => val(p, "free_cash_flow") != null && (val(p, "revenue") ?? 0) > 0).slice(0, 3);
  const fcfMarginPooled =
    pooled.length >= 2 ? pooled.reduce((n, p) => n + val(p, "free_cash_flow")!, 0) / pooled.reduce((d, p) => d + val(p, "revenue")!, 0) : null;
  const fcf = val(latest, "free_cash_flow");
  const cash = val(latest, "cash_and_equivalents");

  return {
    fiscalYear: latest?.fiscal_year ?? null,
    revenue,
    fcf,
    fcfMarginPooled,
    normalizedFcf: fcfMarginPooled != null && revenue ? fcfMarginPooled * revenue : fcf,
    longTermDebt: val(latest, "long_term_debt"),
    cashAndInvestments: cash != null ? cash + (val(latest, "short_term_investments") ?? 0) : null,
    operatingMarginPct: revenue && opIncome != null ? (opIncome / revenue) * 100 : null,
    shares,
    eps: netIncome != null && shares ? netIncome / shares : null,
    dividendPerShare: dividends != null && shares ? dividends / shares : null,
    dividendCagr,
  };
}

/** Years over which growth fades linearly from the stage-1 rate to terminal growth. */
export const FADE_YEARS = 5;

export interface DcfYear {
  year: number;
  growth: number;
  fcf: number;
  pv: number;
}

export interface DcfResult {
  years: DcfYear[];
  baseFcf: number;
  equityValue: number;
  /** Equity value + long-term debt − cash; null when debt or cash isn't reported. */
  enterpriseValue: number | null;
  terminalShare: number;
}

export function multiStageDcf(
  s: StatementInputs,
  growthPct: number,
  marginPct: number,
  costOfEquity: number,
): ModelResult & { dcf?: DcfResult } {
  const base = s.normalizedFcf;
  if (base == null) return fail("Free cash flow not reported");
  if (base <= 0) return fail("Free cash flow is negative — nothing to discount");
  if (!s.shares) return fail("Diluted share count not reported");
  const terminalGrowth = TERMINAL_GROWTH_PCT / 100;
  if (costOfEquity <= terminalGrowth) return fail(`Cost of equity must exceed the ${TERMINAL_GROWTH_PCT}% terminal growth`);

  // Margin slider scales cash flow relative to today's operating margin (1× when it can't be measured).
  const marginFactor = s.operatingMarginPct && s.operatingMarginPct > 0 ? marginPct / s.operatingMarginPct : 1;
  const g = growthPct / 100;
  const years: DcfYear[] = [];
  let fcf = base * marginFactor;
  for (let t = 1; t <= PROJECTION_YEARS + FADE_YEARS; t++) {
    // Stage 1 holds the slider growth; stage 2 steps it down evenly so year 10 grows at g_T.
    const growth = t <= PROJECTION_YEARS ? g : g + ((terminalGrowth - g) * (t - PROJECTION_YEARS)) / FADE_YEARS;
    fcf *= 1 + growth;
    years.push({ year: (s.fiscalYear ?? 0) + t, growth, fcf, pv: fcf / (1 + costOfEquity) ** t });
  }
  const last = years[years.length - 1];
  const terminal = (last.fcf * (1 + terminalGrowth)) / (costOfEquity - terminalGrowth);
  const pvTerminal = terminal / (1 + costOfEquity) ** years.length;
  const equityValue = years.reduce((sum, y) => sum + y.pv, 0) + pvTerminal;
  if (equityValue <= 0) return fail("Projected cash flows are negative at this margin");
  const enterpriseValue =
    s.longTermDebt != null && s.cashAndInvestments != null ? equityValue + s.longTermDebt - s.cashAndInvestments : null;
  return {
    ok: true,
    value: equityValue / s.shares,
    detail: `${growthPct.toFixed(1)}% for 5 yrs, fading to ${TERMINAL_GROWTH_PCT}% by yr 10 · ${marginPct.toFixed(1)}% margin`,
    dcf: { years, baseFcf: base, equityValue, enterpriseValue, terminalShare: pvTerminal / equityValue },
  };
}

export function gordonDdm(s: StatementInputs, dividendGrowth: number, costOfEquity: number): ModelResult {
  if (s.dividendPerShare == null) return fail("No dividends reported");
  if (s.dividendPerShare <= 0) return fail("No dividend paid last year");
  if (costOfEquity <= dividendGrowth) return fail("Dividend growth must be below the cost of equity");
  const value = (s.dividendPerShare * (1 + dividendGrowth)) / (costOfEquity - dividendGrowth);
  return { ok: true, value, detail: `D₀ ${s.dividendPerShare.toFixed(2)} growing ${(dividendGrowth * 100).toFixed(1)}%` };
}

export function grahamValue(s: StatementInputs, growthPct: number, riskFree: number): ModelResult {
  if (s.eps == null) return fail("Net income or share count not reported");
  if (s.eps <= 0) return fail("Loss-making — the formula needs positive EPS");
  if (riskFree <= 0) return fail("Risk-free rate must be positive");
  const multiple = 8.5 + 2 * growthPct;
  if (multiple <= 0) return fail("Growth this negative gives a non-positive multiple");
  const value = (s.eps * multiple * 4.4) / (riskFree * 100);
  return { ok: true, value, detail: `EPS ${s.eps.toFixed(2)} × (8.5 + 2×${growthPct.toFixed(1)}) × 4.4 ÷ ${(riskFree * 100).toFixed(2)}` };
}

export function marginOfSafety(intrinsic: number, price: number): number {
  return (intrinsic - price) / intrinsic;
}

/** The Gordon model's g is a forever rate, so it can't outgrow the economy; the risk-free rate stands in
 * for long-run nominal growth. A 2pp floor on (k_e − g) keeps the value from exploding as g nears k_e. */
export function dividendGrowthCeiling(riskFree: number, costOfEquity: number): number {
  return Math.max(0, Math.min(riskFree, costOfEquity - 0.02));
}

/** Default dividend growth: the company's own DPS growth, between 0% and the sustainable ceiling.
 * (Previously capped only 1pp under k_e, which priced Microsoft's 0.7%-yield dividend at $390.) */
export function defaultDividendGrowth(s: StatementInputs, costOfEquity: number, riskFree: number): number {
  return Math.min(Math.max(s.dividendCagr ?? 0.03, 0), dividendGrowthCeiling(riskFree, costOfEquity));
}
