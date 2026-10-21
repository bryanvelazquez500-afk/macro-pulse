/**
 * Equity DCF for the center Valuation panel: a 10-year projection of free cash flow to equity.
 *
 *   Revenue_t          = Revenue_(t−1) × (1 + growth_t)
 *                        growth_t = slider growth for years 1–5, then fading linearly to g_T by year 10
 *   Operating income_t = Revenue_t × target operating margin
 *   Earnings_t         = Operating income_t × earnings conversion   (historical Net income ÷ Operating income)
 *   FCF_t              = Earnings_t × FCF conversion                (historical Free cash flow ÷ Net income)
 *   Equity value       = Σ FCF_t ÷ (1 + k_e)^t  +  TV ÷ (1 + k_e)^10,   TV = FCF_10 × (1 + g_T) ÷ (k_e − g_T)
 *   Value per share    = Equity value ÷ diluted shares;  Enterprise value = Equity value + long-term debt − cash
 *
 * Free cash flow here is GAAP operating cash flow − capital expenditures. It is measured after interest,
 * so it belongs to shareholders: it is discounted at the cost of equity (CAPM, k_e = r_f + β × ERP) and
 * gives EQUITY value. (Audit, Oct 2026: this panel used to discount it at a flat 9% labelled WACC and call
 * the result enterprise value — the wrong rate for after-interest cash flow, and not company-specific.)
 *
 * Defaults are the company's own GAAP history, kept to realistic ranges: growth = 3-year revenue CAGR held
 * to −10%…20% (and faded, not held forever), margin = 3-year pooled operating margin (not one possibly-peak
 * year), conversions = 3-year pooled ratios, terminal growth 2.5% (long-run GDP; CLAUDE.md caps it at 2.5–3%).
 */

import type { FinancialPeriod } from "@/lib/api";

export const PROJECTION_YEARS = 5; // explicit growth stage
export const FADE_YEARS = 5; // growth fades linearly to terminal growth over years 6–10
export const TERMINAL_GROWTH_PCT = 2.5;
/** Terminal value above this share of total value needs a reality check on near-term growth (CLAUDE.md). */
export const TERMINAL_SHARE_WARNING = 0.75;

export const SLIDER_RANGES = {
  revenueGrowthPct: { min: -20, max: 50, step: 0.5 },
  operatingMarginPct: { min: 0, max: 100, step: 0.5 },
  costOfEquityPct: { min: 5, max: 20, step: 0.25 },
} as const;

// Realistic bounds for the DEFAULT growth (the slider still reaches −20…50%).
const DEFAULT_GROWTH_FLOOR = -10;
const DEFAULT_GROWTH_CAP = 20;

export interface Assumptions {
  revenueGrowthPct: number;
  operatingMarginPct: number;
  costOfEquityPct: number;
}

export interface Baseline {
  baseFiscalYear: number;
  baseRevenue: number;
  earningsConversion: number;
  fcfConversion: number;
  historicalRevenueCagrPct: number | null;
  latestOperatingMarginPct: number | null;
  pooledOperatingMarginPct: number | null;
  shares: number | null;
  longTermDebt: number | null;
  cashAndInvestments: number | null;
  defaults: Assumptions;
  notes: string[];
}

export interface ProjectedYear {
  fiscalYear: number;
  growth: number; // decimal
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
  equityValue: number;
  perShare: number | null;
  enterpriseValue: number | null;
  terminalShare: number; // PV of terminal value ÷ equity value
}

// Fallbacks when history can't support a conversion rate: 21% US statutory tax, FCF ≈ earnings.
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

/**
 * Starting point and default slider values from annual history (newest first). `costOfEquity` is the
 * company's CAPM rate (decimal); without it the default discount rate falls back to 9% and says so.
 */
export function deriveBaseline(annualPeriods: FinancialPeriod[], costOfEquity: number | null = null): Baseline | null {
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
  const pooled = pooledRatio(recent, (p) => val(p, "operating_income"), (p) => val(p, "revenue"));
  const pooledOperatingMarginPct = pooled != null ? pooled * 100 : null;
  let defaultMargin = pooledOperatingMarginPct ?? latestOperatingMarginPct;
  if (defaultMargin == null) {
    const netIncome = val(base, "net_income");
    defaultMargin = netIncome != null ? ((netIncome / baseRevenue) * 100) / earningsConversion : 15;
    notes.push("Operating margin not reported — default margin implied from net margin.");
  }

  let growthDefault = historicalRevenueCagrPct ?? 5;
  if (historicalRevenueCagrPct == null) notes.push("Too little revenue history for a growth rate — default growth set to 5%.");
  if (growthDefault > DEFAULT_GROWTH_CAP || growthDefault < DEFAULT_GROWTH_FLOOR) {
    notes.push(
      `Default growth held to ${clamp(growthDefault, DEFAULT_GROWTH_FLOOR, DEFAULT_GROWTH_CAP)}% (3-year CAGR ${growthDefault.toFixed(1)}%) — few companies sustain more than ${DEFAULT_GROWTH_CAP}% for five years.`,
    );
    growthDefault = clamp(growthDefault, DEFAULT_GROWTH_FLOOR, DEFAULT_GROWTH_CAP);
  }

  if (costOfEquity == null) notes.push("CAPM inputs unavailable — default cost of equity set to 9%.");

  const { revenueGrowthPct: g, operatingMarginPct: m, costOfEquityPct: k } = SLIDER_RANGES;
  const cash = val(base, "cash_and_equivalents");
  return {
    baseFiscalYear: base.fiscal_year!,
    baseRevenue,
    earningsConversion,
    fcfConversion,
    historicalRevenueCagrPct,
    latestOperatingMarginPct,
    pooledOperatingMarginPct,
    shares: val(base, "diluted_shares"),
    longTermDebt: val(base, "long_term_debt"),
    cashAndInvestments: cash != null ? cash + (val(base, "short_term_investments") ?? 0) : null,
    defaults: {
      revenueGrowthPct: clamp(snap(growthDefault, g.step), g.min, g.max),
      operatingMarginPct: clamp(snap(defaultMargin, m.step), m.min, m.max),
      costOfEquityPct: clamp(snap((costOfEquity ?? 0.09) * 100, k.step), k.min, k.max),
    },
    notes,
  };
}

export function project(baseline: Baseline, a: Assumptions): Valuation {
  const g = a.revenueGrowthPct / 100;
  const margin = a.operatingMarginPct / 100;
  const ke = a.costOfEquityPct / 100;
  const gT = TERMINAL_GROWTH_PCT / 100;

  const years: ProjectedYear[] = [];
  let revenue = baseline.baseRevenue;
  for (let t = 1; t <= PROJECTION_YEARS + FADE_YEARS; t++) {
    // Years 1–5 at the slider growth; years 6–10 step down evenly so year 10 grows at g_T.
    const growth = t <= PROJECTION_YEARS ? g : g + ((gT - g) * (t - PROJECTION_YEARS)) / FADE_YEARS;
    revenue *= 1 + growth;
    const operatingIncome = revenue * margin;
    const earnings = operatingIncome * baseline.earningsConversion;
    const fcf = earnings * baseline.fcfConversion;
    years.push({ fiscalYear: baseline.baseFiscalYear + t, growth, revenue, operatingIncome, earnings, fcf, pvFcf: fcf / (1 + ke) ** t });
  }

  const pvExplicitFcf = years.reduce((sum, y) => sum + y.pvFcf, 0);
  // The cost-of-equity slider's 5% floor keeps k_e above the 2.5% terminal growth, so the denominator stays positive.
  const terminalValue = (years[years.length - 1].fcf * (1 + gT)) / (ke - gT);
  const pvTerminalValue = terminalValue / (1 + ke) ** years.length;
  const equityValue = pvExplicitFcf + pvTerminalValue;
  const { shares, longTermDebt, cashAndInvestments } = baseline;
  return {
    years,
    pvExplicitFcf,
    terminalValue,
    pvTerminalValue,
    equityValue,
    perShare: shares && equityValue > 0 ? equityValue / shares : null,
    enterpriseValue: longTermDebt != null && cashAndInvestments != null ? equityValue + longTermDebt - cashAndInvestments : null,
    terminalShare: equityValue > 0 ? pvTerminalValue / equityValue : 0,
  };
}
