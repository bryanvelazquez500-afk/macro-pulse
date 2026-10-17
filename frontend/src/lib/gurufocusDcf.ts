/**
 * GuruFocus-style earnings-based DCF: a two-stage model on earnings per share plus tangible book value.
 *
 *   Fair value = EPS × x(1 − x^n₁)/(1 − x)  +  EPS × x^n₁ × y(1 − y^n₂)/(1 − y)  +  tangible book value / share
 *   x = (1 + g₁)/(1 + d),  y = (1 + g₂)/(1 + d)
 *
 *   g₁  growth stage, n₁ = 10 years: the stock's historical 10-year EPS growth rate (CAGR of
 *       split-adjusted diluted EPS), falling back to 5 or 3 years when 10 isn't available
 *   g₂  terminal stage, n₂ = 10 years: fixed 4%
 *   d   discount rate: 10-year Treasury yield + 6% equity risk premium
 *
 * The terminal stage is a further 10 years, not a perpetuity, so nothing beyond year 20 is valued —
 * the tangible book value stands in for what's left. Defaults follow GuruFocus's published calculator
 * (EPS without NRI, 10 + 10 years, 4%, Treasury + 6%). Differences: EPS here is the latest fiscal year's
 * reported diluted EPS (GuruFocus uses trailing-twelve-month EPS excluding non-recurring items), and the
 * Treasury yield isn't rounded (GuruFocus rounds it to a whole percent).
 */

import type { FinancialPeriod } from "@/lib/api";

export const GF_GROWTH_YEARS = 10;
export const GF_TERMINAL_YEARS = 10;
export const GF_TERMINAL_GROWTH = 0.04;
export const GF_EQUITY_RISK_PREMIUM = 0.06;

export interface EpsGrowth {
  rate: number; // decimal CAGR
  years: number; // span actually used (10, 5 or 3)
  fromYear: number;
  toYear: number;
  fromEps: number;
  toEps: number;
}

const value = (p: FinancialPeriod, key: keyof FinancialPeriod["line_items"]) => p.line_items[key]?.value ?? null;

export function dilutedEps(p: FinancialPeriod): number | null {
  const ni = value(p, "net_income");
  const shares = value(p, "diluted_shares");
  return ni != null && shares ? ni / shares : null;
}

/** Historical EPS CAGR over 10 years, else 5, else 3 — CAGR needs positive EPS at both ends. */
export function historicalEpsGrowth(annual: FinancialPeriod[]): EpsGrowth | null {
  const latest = annual.find((p) => p.fiscal_year != null && dilutedEps(p) != null);
  if (!latest) return null;
  const toEps = dilutedEps(latest)!;
  if (toEps <= 0) return null;
  for (const years of [10, 5, 3]) {
    const base = annual.find((p) => p.fiscal_year === latest.fiscal_year! - years);
    const fromEps = base ? dilutedEps(base) : null;
    if (fromEps != null && fromEps > 0) {
      return { rate: (toEps / fromEps) ** (1 / years) - 1, years, fromYear: base!.fiscal_year!, toYear: latest.fiscal_year!, fromEps, toEps };
    }
  }
  return null;
}

/** Σ_{t=1..n} r^t = r(1 − r^n)/(1 − r), or n when r = 1. */
function geometricSum(r: number, n: number): number {
  return Math.abs(r - 1) < 1e-12 ? n : (r * (1 - r ** n)) / (1 - r);
}

export interface GuruFocusDcfResult {
  fairValue: number;
  growthStageValue: number;
  terminalStageValue: number;
  tangibleBookPerShare: number;
  eps: number;
  epsYear: number | null;
  growth: EpsGrowth;
  discountRate: number;
}

export type GuruFocusDcfOutcome = { ok: true; result: GuruFocusDcfResult } | { ok: false; reason: string };

export function guruFocusDcf(annual: FinancialPeriod[], riskFreeRate: number): GuruFocusDcfOutcome {
  const latest = annual[0];
  if (!latest) return { ok: false, reason: "No annual statements" };
  const eps = dilutedEps(latest);
  if (eps == null) return { ok: false, reason: "Net income or diluted shares not reported" };
  if (eps <= 0) return { ok: false, reason: "Loss-making — an earnings-based DCF needs positive EPS" };
  const growth = historicalEpsGrowth(annual);
  if (!growth) return { ok: false, reason: "Needs positive EPS at least 3 years apart to measure historical growth" };

  const d = riskFreeRate + GF_EQUITY_RISK_PREMIUM;
  const x = (1 + growth.rate) / (1 + d);
  const y = (1 + GF_TERMINAL_GROWTH) / (1 + d);
  const growthStageValue = eps * geometricSum(x, GF_GROWTH_YEARS);
  const terminalStageValue = eps * x ** GF_GROWTH_YEARS * geometricSum(y, GF_TERMINAL_YEARS);

  const shares = value(latest, "diluted_shares")!;
  const equity = value(latest, "stockholders_equity");
  const tangibleBookPerShare = equity != null ? (equity - (value(latest, "goodwill_and_intangibles") ?? 0)) / shares : 0;

  return {
    ok: true,
    result: {
      fairValue: growthStageValue + terminalStageValue + tangibleBookPerShare,
      growthStageValue,
      terminalStageValue,
      tangibleBookPerShare,
      eps,
      epsYear: latest.fiscal_year,
      growth,
      discountRate: d,
    },
  };
}
