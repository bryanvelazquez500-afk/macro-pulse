/**
 * Two-stage discounted-earnings DCF (GuruFocus-style) — pure math, no I/O, so it's unit-testable and
 * recalculates instantly on every control change.
 *
 *   x = (1 + g1)/(1 + d),  y = (1 + g2)/(1 + d)
 *   Growth value   = E0 · x(1 − xⁿ)/(1 − x)            (n · E0 when x = 1)
 *   Terminal value = E0 · xⁿ · y(1 − yᵐ)/(1 − y)        (m · E0 · xⁿ when y = 1)
 *   Fair value     = growth + terminal (+ tangible book value per share when enabled)
 *   Margin of safety = (fair value − price) / fair value
 *
 * Rates are decimals (0.10 = 10%). Pinned by the test vector in dcf.test.ts.
 */

export const DEFAULT_GROWTH_YEARS = 10;
export const DEFAULT_TERMINAL_YEARS = 10;
export const DEFAULT_TERMINAL_GROWTH = 0.04;
export const EQUITY_RISK_PREMIUM = 0.06;
export const GROWTH_FLOOR = 0.05;
export const GROWTH_CAP = 0.2;

export interface DcfParams {
  e0: number; // base per-share value
  d: number; // discount rate
  g1: number; // growth-stage growth rate
  n: number; // growth-stage years
  g2: number; // terminal-stage growth rate
  m: number; // terminal-stage years
  tbv?: number; // tangible book value per share
  addTbv?: boolean;
}

export interface DcfResult {
  growthValue: number;
  terminalValue: number;
  fairValue: number;
}

/** Σ_{t=1..years} rᵗ — `years` when r = 1 instead of dividing by zero. */
function geometricSum(r: number, years: number): number {
  return Math.abs(r - 1) < 1e-12 ? years : (r * (1 - r ** years)) / (1 - r);
}

export function twoStage(p: DcfParams): DcfResult {
  const x = (1 + p.g1) / (1 + p.d);
  const y = (1 + p.g2) / (1 + p.d);
  const growthValue = p.e0 * geometricSum(x, p.n);
  const terminalValue = p.e0 * x ** p.n * geometricSum(y, p.m);
  return { growthValue, terminalValue, fairValue: growthValue + terminalValue + (p.addTbv ? (p.tbv ?? 0) : 0) };
}

export function marginOfSafety(fairValue: number, price: number): number | null {
  return fairValue > 0 ? (fairValue - price) / fairValue : null;
}

/** d = ceil(10-year Treasury, whole percent) + 6%. Rounded first so 4.0000001 stays 4. */
export function defaultDiscountRate(t10Pct: number): number {
  return (Math.ceil(Number(t10Pct.toFixed(6))) + EQUITY_RISK_PREMIUM * 100) / 100;
}

/** g1 = the metric's historical 10-year growth, clamped to 5–20% (5% when there's no history). */
export function defaultGrowthRate(h10Pct: number | null): number {
  if (h10Pct == null || !Number.isFinite(h10Pct)) return GROWTH_FLOOR;
  return Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, h10Pct / 100));
}

/** The g1 that makes fair value equal the price, everything else fixed (bisection). Null when out of range. */
export function reverseDcfGrowth(p: DcfParams, price: number, lo = -0.99, hi = 2): number | null {
  if (!(p.e0 > 0) || !(price > 0)) return null;
  const gap = (g: number) => twoStage({ ...p, g1: g }).fairValue - price;
  if (gap(lo) > 0 || gap(hi) < 0) return null; // fair value rises with g1, so no root in the bracket
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ProjectionRow {
  year: number;
  stage: "growth" | "terminal";
  earnings: number;
  discountFactor: number;
  presentValue: number;
}

/** Year-by-year cash flows; the present values sum to growth + terminal value. */
export function projection(p: DcfParams): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  let earnings = p.e0;
  for (let t = 1; t <= p.n + p.m; t++) {
    const stage = t <= p.n ? "growth" : "terminal";
    earnings *= 1 + (stage === "growth" ? p.g1 : p.g2);
    const discountFactor = 1 / (1 + p.d) ** t;
    rows.push({ year: t, stage, earnings, discountFactor, presentValue: earnings * discountFactor });
  }
  return rows;
}
