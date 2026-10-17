/**
 * 5-year earnings & free-cash-flow projection with a discounted-cash-flow valuation.
 *
 *   Revenue_t          = Revenue_base × (1 + growth)^t
 *   Operating income_t = Revenue_t × target operating margin
 *   Earnings_t         = Operating income_t × earnings conversion   (historical Net Income ÷ Operating Income)
 *   FCF_t              = Earnings_t × FCF conversion                (historical Free Cash Flow ÷ Net Income)
 *   Enterprise value   = Σ FCF_t ÷ (1 + WACC)^t  +  terminal value ÷ (1 + WACC)^5
 *   Terminal value     = FCF_5 × (1 + g) ÷ (WACC − g)                (Gordon growth, g = TERMINAL_GROWTH_PCT)
 *
 * The two conversion rates come from the company's own last three fiscal years, so
 * tax, interest and capex intensity carry forward without extra assumptions.
 */

import type { FinancialPeriod } from "@/lib/api";

export const PROJECTION_YEARS = 5;
export const TERMINAL_GROWTH_PCT = 2.5;

export const SLIDER_RANGES = {
  revenueGrowthPct: { min: -20, max: 50, step: 0.5 },
  operatingMarginPct: { min: 0, max: 100, step: 0.5 },
  waccPct: { min: 5, max: 20, step: 0.25 },
} as const;

export interface Assumptions {
  revenueGrowthPct: number;
  operatingMarginPct: number;
  waccPct: number;
}

export interface Baseline {
  baseFiscalYear: number;
  baseRevenue: number;
  earningsConversion: number;
  fcfConversion: number;
  historicalRevenueCagrPct: number | null;
  latestOperatingMarginPct: number | null;
  defaults: Assumptions;
  notes: string[];
}

export interface ProjectedYear {
  fiscalYear: number;
  revenue: number;
  operatingIncome: number;
  earnings: number;
  fcf: number;
  pvFcf: number;
}

export interface Valuation {
  years: ProjectedYear[];
  pvExplicitFcf: number;
  terminalValue: number;
  pvTerminalValue: number;
  enterpriseValue: number;
}

const DEFAULT_WACC_PCT = 9;
// Fallbacks when history can't support a conversion rate: 21% statutory tax, FCF ≈ earnings.
const DEFAULT_EARNINGS_CONVERSION = 0.79;
const DEFAULT_FCF_CONVERSION = 1;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const snap = (v: number, step: number) => Math.round(v / step) * step;

function val(p: FinancialPeriod, key: keyof FinancialPeriod["line_items"]): number | null {
  return p.line_items[key]?.value ?? null;
}

/** Ratio of summed numerators to summed denominators over periods where both exist and the denominator is positive. */
function pooledRatio(periods: FinancialPeriod[], num: (p: FinancialPeriod) => number | null, den: (p: FinancialPeriod) => number | null) {
  let n = 0;
  let d = 0;
  for (const p of periods) {
    const a = num(p);
    const b = den(p);
    if (a != null && b != null && b > 0) {
      n += a;
      d += b;
    }
  }
  return d > 0 ? n / d : null;
}

/** Derives the projection's starting point and default slider values from annual history (newest first). */
export function deriveBaseline(annualPeriods: FinancialPeriod[]): Baseline | null {
  const withRevenue = annualPeriods.filter((p) => val(p, "revenue") != null && p.fiscal_year != null);
  const base = withRevenue[0];
  if (!base) return null;

  const notes: string[] = [];
  const recent = withRevenue.slice(0, 3);
  const baseRevenue = val(base, "revenue")!;

  let earningsConversion = pooledRatio(recent, (p) => val(p, "net_income"), (p) => val(p, "operating_income"));
  if (earningsConversion == null) {
    notes.push("Operating income history unavailable — earnings assume a 21% tax rate on operating income.");
    earningsConversion = DEFAULT_EARNINGS_CONVERSION;
  }
  earningsConversion = clamp(earningsConversion, 0.4, 1.2);

  let fcfConversion = pooledRatio(recent, (p) => val(p, "free_cash_flow"), (p) => val(p, "net_income"));
  if (fcfConversion == null) {
    notes.push("Cash flow history unavailable — free cash flow assumed equal to earnings.");
    fcfConversion = DEFAULT_FCF_CONVERSION;
  }
  fcfConversion = clamp(fcfConversion, 0.3, 1.5);

  // Revenue CAGR over up to three years.
  const oldest = withRevenue[Math.min(3, withRevenue.length - 1)];
  const years = base.fiscal_year! - oldest.fiscal_year!;
  const oldestRevenue = val(oldest, "revenue")!;
  const historicalRevenueCagrPct =
    years > 0 && oldestRevenue > 0 && baseRevenue > 0 ? ((baseRevenue / oldestRevenue) ** (1 / years) - 1) * 100 : null;

  const operatingIncome = val(base, "operating_income");
  const latestOperatingMarginPct = operatingIncome != null ? (operatingIncome / baseRevenue) * 100 : null;
  let defaultMargin = latestOperatingMarginPct;
  if (defaultMargin == null) {
    const netIncome = val(base, "net_income");
    defaultMargin = netIncome != null ? ((netIncome / baseRevenue) * 100) / earningsConversion : 15;
    notes.push("Operating margin not reported — default margin implied from net margin.");
  }

  const { revenueGrowthPct: g, operatingMarginPct: m } = SLIDER_RANGES;
  return {
    baseFiscalYear: base.fiscal_year!,
    baseRevenue,
    earningsConversion,
    fcfConversion,
    historicalRevenueCagrPct,
    latestOperatingMarginPct,
    defaults: {
      revenueGrowthPct: clamp(snap(historicalRevenueCagrPct ?? 5, g.step), g.min, g.max),
      operatingMarginPct: clamp(snap(defaultMargin, m.step), m.min, m.max),
      waccPct: DEFAULT_WACC_PCT,
    },
    notes,
  };
}

export function project(baseline: Baseline, a: Assumptions): Valuation {
  const growth = a.revenueGrowthPct / 100;
  const margin = a.operatingMarginPct / 100;
  const wacc = a.waccPct / 100;
  const terminalGrowth = TERMINAL_GROWTH_PCT / 100;

  const years: ProjectedYear[] = [];
  for (let t = 1; t <= PROJECTION_YEARS; t++) {
    const revenue = baseline.baseRevenue * (1 + growth) ** t;
    const operatingIncome = revenue * margin;
    const earnings = operatingIncome * baseline.earningsConversion;
    const fcf = earnings * baseline.fcfConversion;
    years.push({ fiscalYear: baseline.baseFiscalYear + t, revenue, operatingIncome, earnings, fcf, pvFcf: fcf / (1 + wacc) ** t });
  }

  const pvExplicitFcf = years.reduce((sum, y) => sum + y.pvFcf, 0);
  // WACC's 5% floor keeps it above the 2.5% terminal growth rate, so the denominator stays positive.
  const terminalValue = (years[years.length - 1].fcf * (1 + terminalGrowth)) / (wacc - terminalGrowth);
  const pvTerminalValue = terminalValue / (1 + wacc) ** PROJECTION_YEARS;

  return { years, pvExplicitFcf, terminalValue, pvTerminalValue, enterpriseValue: pvExplicitFcf + pvTerminalValue };
}
