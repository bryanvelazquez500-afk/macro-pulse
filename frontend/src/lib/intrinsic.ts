/**
 * Intrinsic Valuation Station models. All rates are decimals (0.051 = 5.1%) except where noted.
 *
 *   CAPM          k_e  = r_f + β × ERP                     (live 10Y Treasury, Damodaran sector beta & ERP)
 *   Gordon DDM    Value/share = D_0 × (1 + g_d) ÷ (k_e − g_d)   (only when dividends are ≥25% of EPS)
 *   Graham        Value/share = EPS × (8.5 + 2g) × 4.4 ÷ Y   (Graham's 1974 revision; g and Y in percent)
 *                   EPS = latest fiscal year's GAAP diluted EPS
 *                   g   = the company's own 5-year diluted-EPS CAGR, held to 0–15%
 *                   Y   = Moody's Aaa corporate bond yield (FRED DAAA) — 4.4 was the Aaa yield when Graham wrote it
 *   Margin of safety = (intrinsic − price) ÷ intrinsic
 *
 * Audit (Oct 2026): Graham used the 10-year Treasury as Y (≈1pp below Aaa, inflating values ~19%) and the
 * center panel's revenue-growth slider as g (revenue growth is not EPS growth); both corrected. The DCF
 * lives in the center Valuation panel (lib/valuation.ts) and the DCF Calculator (lib/dcf.ts).
 * Every model returns either a value or the reason it isn't meaningful for this company.
 */

import type { FinancialPeriod } from "@/lib/api";

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
  /** Diluted EPS CAGR over 5 years (else 3) between positive endpoints; null otherwise. */
  epsCagr: number | null;
  epsCagrYears: number | null;
}

export function statementInputs(annual: FinancialPeriod[]): StatementInputs {
  const latest = annual[0];
  const shares = val(latest, "diluted_shares");
  const revenue = val(latest, "revenue");
  const opIncome = val(latest, "operating_income");
  // GAAP EPS numerator: net income available to common shareholders (after preferred dividends), when tagged.
  const toCommon = (p: FinancialPeriod | undefined) => val(p, "net_income_common") ?? val(p, "net_income");
  const netIncome = toCommon(latest);
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

  const epsOf = (p: FinancialPeriod | undefined) => {
    const ni = toCommon(p);
    const sh = val(p, "diluted_shares");
    return ni != null && sh ? ni / sh : null;
  };
  let epsCagr: number | null = null;
  let epsCagrYears: number | null = null;
  const nowEps = epsOf(latest);
  if (nowEps != null && nowEps > 0 && latest?.fiscal_year != null) {
    for (const years of [5, 3]) {
      const then = epsOf(annual.find((p) => p.fiscal_year === latest.fiscal_year! - years));
      if (then != null && then > 0) {
        epsCagr = (nowEps / then) ** (1 / years) - 1;
        epsCagrYears = years;
        break;
      }
    }
  }

  return {
    epsCagr,
    epsCagrYears,
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

/** Below this payout ratio a dividend model mostly measures how little is paid out, not what the business is worth. */
export const DDM_MIN_PAYOUT = 0.25;

export function gordonDdm(s: StatementInputs, dividendGrowth: number, costOfEquity: number): ModelResult {
  if (s.dividendPerShare == null) return fail("No dividends reported");
  if (s.dividendPerShare <= 0) return fail("No dividend paid last year");
  if (s.eps != null && s.eps > 0 && s.dividendPerShare / s.eps < DDM_MIN_PAYOUT) {
    return fail(
      `Not meaningful: dividends are only ${((s.dividendPerShare / s.eps) * 100).toFixed(0)}% of earnings — the company returns or reinvests most of its cash another way (buybacks, growth), so a dividend model would understate it.`,
    );
  }
  if (costOfEquity <= dividendGrowth) return fail("Dividend growth must be below the cost of equity");
  const value = (s.dividendPerShare * (1 + dividendGrowth)) / (costOfEquity - dividendGrowth);
  return { ok: true, value, detail: `D₀ ${s.dividendPerShare.toFixed(2)} growing ${(dividendGrowth * 100).toFixed(1)}%` };
}

/** Graham's g: the company's own EPS growth, held to 0–15% (Graham warned his formula overstates high growers). */
export const GRAHAM_GROWTH_CAP_PCT = 15;
export function grahamGrowthPct(s: StatementInputs): number {
  return Math.min(GRAHAM_GROWTH_CAP_PCT, Math.max(0, (s.epsCagr ?? 0) * 100));
}

export function grahamValue(s: StatementInputs, growthPct: number, bondYield: number): ModelResult {
  if (s.eps == null) return fail("Net income or share count not reported");
  if (s.eps <= 0) return fail("Loss-making — the formula needs positive EPS");
  if (bondYield <= 0) return fail("Bond yield must be positive");
  const multiple = 8.5 + 2 * growthPct;
  const value = (s.eps * multiple * 4.4) / (bondYield * 100);
  return { ok: true, value, detail: `EPS ${s.eps.toFixed(2)} × (8.5 + 2×${growthPct.toFixed(1)}) × 4.4 ÷ ${(bondYield * 100).toFixed(2)}` };
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
