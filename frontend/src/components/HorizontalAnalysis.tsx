"use client";

/**
 * Horizontal analysis: each compared company's line items across 5 or 10 years of 10-Ks (annual) or
 * 10-Qs (quarterly), as % change vs. the comparable prior period, an index (first period = 100) or raw
 * values. One collapsible card per company; clicking a row charts that line item over time.
 *
 * Uses the statements the comparison already loaded (12 fiscal years / ~44 quarters), so expanding a
 * card never makes a new request. Younger companies simply show every period they've filed.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";

import type { FinancialPeriod, HelperMetricKey, MetricKey, PeriodType } from "@/lib/api";
import { CompanyEntry, symbolOf } from "@/lib/comparisonStore";
import { Segmented } from "@/components/Segmented";
import { currencySymbol, formatAccounting, formatChange, formatShares, periodLabel } from "@/lib/format";
import { heat } from "@/lib/heat";
import { GRAND_TOTALS, SUBTOTALS } from "@/lib/ledger";
import { flow } from "@/lib/motion";
import { Pt, smoothArea, smoothLine } from "@/lib/smoothPath";

type Mode = "change" | "index" | "value";
type Statement = "all" | "income" | "cash" | "balance";
type Unit = "money" | "shares" | "perShare";

interface RowDef {
  key: string;
  label: string;
  unit: Unit;
  /** Computed from other line items rather than reported directly. */
  derived?: boolean;
  get: (p: FinancialPeriod) => number | null;
}

const item = (p: FinancialPeriod, k: MetricKey | HelperMetricKey) => p.line_items[k]?.value ?? null;
const reported = (key: MetricKey | HelperMetricKey, label: string, unit: Unit = "money"): RowDef => ({ key, label, unit, get: (p) => item(p, key) });

// Every line item the pipelines extract, in statement order.
const SECTIONS: { key: Exclude<Statement, "all">; label: string; rows: RowDef[] }[] = [
  {
    key: "income",
    label: "Income statement",
    rows: [
      reported("revenue", "Revenue"),
      reported("cost_of_goods_sold", "Cost of Goods Sold"),
      {
        key: "gross_profit",
        label: "Gross Profit",
        unit: "money",
        derived: true,
        get: (p) => {
          const [r, c] = [item(p, "revenue"), item(p, "cost_of_goods_sold")];
          return r != null && c != null ? r - c : null;
        },
      },
      reported("sga_expense", "SG&A Expense"),
      reported("operating_income", "Operating Income"),
      reported("pretax_income", "Pre-tax Income"),
      reported("income_tax_expense", "Income Tax Expense"),
      reported("net_income", "Net Income"),
      reported("diluted_shares", "Diluted Shares", "shares"),
      {
        key: "eps",
        label: "Diluted EPS",
        unit: "perShare",
        derived: true,
        get: (p) => {
          const [ni, sh] = [item(p, "net_income_common") ?? item(p, "net_income"), item(p, "diluted_shares")];
          return ni != null && sh ? ni / sh : null;
        },
      },
    ],
  },
  {
    key: "cash",
    label: "Cash flow",
    rows: [
      reported("operating_cash_flow", "Operating Cash Flow"),
      reported("capital_expenditures", "Capital Expenditures"),
      reported("free_cash_flow", "Free Cash Flow"),
      reported("dividends_paid", "Dividends Paid"),
    ],
  },
  {
    key: "balance",
    label: "Balance sheet · period end",
    rows: [
      reported("cash_and_equivalents", "Cash & Equivalents"),
      reported("short_term_investments", "Short-Term Investments"),
      reported("accounts_receivable", "Accounts Receivable"),
      reported("inventory", "Inventory"),
      reported("current_assets", "Total Current Assets"),
      reported("goodwill_and_intangibles", "Goodwill & Intangibles"),
      reported("total_assets", "Total Assets"),
      reported("current_liabilities", "Total Current Liabilities"),
      reported("long_term_debt", "Long-Term Debt"),
      reported("total_liabilities", "Total Liabilities"),
      reported("retained_earnings", "Retained Earnings"),
      reported("stockholders_equity", "Stockholders' Equity"),
    ],
  },
];
const ALL_ROWS = SECTIONS.flatMap((sec) => sec.rows);
const STATEMENT_OPTIONS: { key: Statement; label: string }[] = [
  { key: "all", label: "All statements" },
  { key: "income", label: "Income" },
  { key: "cash", label: "Cash flow" },
  { key: "balance", label: "Balance sheet" },
];

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "change", label: "% change", hint: "vs. the comparable prior period" },
  { key: "index", label: "Index", hint: "first period in view = 100" },
  { key: "value", label: "Values", hint: "as reported" },
];

// Ledger table cells: uppercase header labels over a strong rule, hairline-ruled rows.
const TH = "border-b border-line-strong bg-panel px-4 py-3 text-[11px] leading-4 font-bold tracking-[0.09em] whitespace-nowrap text-ink-3 uppercase";
const TD = "border-t border-line px-4 py-2.5";

// ── data ────────────────────────────────────────────────────────────────────

interface Cell {
  period: FinancialPeriod;
  value: number | null;
  change: number | null; // percent vs. comparable prior period
  index: number | null; // first period in view = 100
}

/** The comparable prior period: the previous fiscal year, or the same quarter a year earlier. */
function priorOf(p: FinancialPeriod, all: FinancialPeriod[], periodType: PeriodType): FinancialPeriod | null {
  if (periodType === "annual") return all.find((q) => q.fiscal_year != null && q.fiscal_year === (p.fiscal_year ?? NaN) - 1) ?? null;
  if (p.fiscal_year != null && p.fiscal_period)
    return all.find((q) => q.fiscal_period === p.fiscal_period && q.fiscal_year === p.fiscal_year! - 1) ?? null;
  const target = new Date(p.end).getTime() - 365 * 864e5;
  return all.find((q) => Math.abs(new Date(q.end).getTime() - target) < 15 * 864e5) ?? null;
}

function pctChange(now: number | null, before: number | null): number | null {
  if (now == null || before == null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

function buildCells(periods: FinancialPeriod[], all: FinancialPeriod[], row: RowDef, periodType: PeriodType): Cell[] {
  const base = periods.map(row.get).find((v) => v != null && v > 0) ?? null;
  return periods.map((p) => {
    const value = row.get(p);
    const prior = priorOf(p, all, periodType);
    return {
      period: p,
      value,
      change: pctChange(value, prior ? row.get(prior) : null),
      index: value != null && base != null ? (value / base) * 100 : null,
    };
  });
}

/**
 * Compound annual growth between the first and last values in view (both positive). Quarters are matched
 * on fiscal quarter (Q3 vs. an earlier Q3), so seasonality doesn't masquerade as growth.
 */
function cagr(cells: Cell[]): number | null {
  const pts = cells.filter((c) => c.value != null);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const fp = last.period.fiscal_period;
  const first = fp && fp !== "FY" ? pts.find((c) => c.period.fiscal_period === fp && c !== last) : pts[0];
  if (!first) return null;
  const years = (new Date(last.period.end).getTime() - new Date(first.period.end).getTime()) / (365.25 * 864e5);
  if (years < 0.9 || first.value! <= 0 || last.value! <= 0) return null;
  return ((last.value! / first.value!) ** (1 / years) - 1) * 100;
}

/** Display value; money and per-share negatives in parentheses (accounting style). */
function fmt(v: number | null, unit: Unit, currency: string): string {
  if (v == null) return "—";
  if (unit === "shares") return formatShares(v);
  if (unit === "perShare") {
    const abs = `${currencySymbol(currency)}${Math.abs(v).toFixed(2)}`;
    return v < 0 ? `(${abs})` : abs;
  }
  return formatAccounting(v, currency);
}

/** Width of the element, kept in sync as it resizes (charts draw in SVG units = CSS pixels). */
function useWidth(initial = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Small smooth sparkline for the CAGR tiles: spruce line over a mint area, last point emphasised. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const [ref, width] = useWidth(160);
  const pts = values.map((v, i) => (v == null ? null : ([i, v] as [number, number])));
  const real = pts.filter((p): p is [number, number] => p != null);
  const H = 36;
  if (real.length < 2) return <div ref={ref} className="h-9" />;
  const lo = Math.min(...real.map((p) => p[1]));
  const hi = Math.max(...real.map((p) => p[1]));
  const sx = (i: number) => 3 + (i / Math.max(1, values.length - 1)) * (width - 6);
  const sy = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (H - 8);
  const xy = pts.map((p) => (p ? ([sx(p[0]), sy(p[1])] as Pt) : null));
  const last = real[real.length - 1];
  return (
    <div ref={ref} className="h-9">
      <svg width={width} height={H} aria-hidden className="overflow-visible">
        <path d={smoothArea(xy, H)} fill="var(--mint)" opacity={0.7} />
        <path d={smoothLine(xy)} pathLength={1} className="chart-draw" fill="none" stroke="var(--spruce)" strokeWidth={2} strokeLinecap="round" />
        <circle cx={sx(last[0])} cy={sy(last[1])} r={3} fill="var(--spruce)" stroke="var(--panel)" strokeWidth={2} />
      </svg>
    </div>
  );
}

// ── chart ───────────────────────────────────────────────────────────────────

function TrendChart({
  cells,
  label,
  mode,
  unit,
  currency,
}: {
  cells: Cell[];
  label: string;
  mode: Mode;
  unit: Unit;
  currency: string;
}) {
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  // % change plots the index (a level), so the line stays readable; the tooltip carries the change.
  const y = (c: Cell) => (mode === "value" ? c.value : c.index);
  const pts = cells.map((c, i) => ({ i, c, v: y(c) })).filter((p): p is { i: number; c: Cell; v: number } => p.v != null);
  const H = 220;
  const pad = { l: 72, r: 24, t: 16, b: 30 };
  if (pts.length < 2) return <p className="py-8 text-center text-[13px] text-ink-3">Not enough history to chart {label}.</p>;

  const lo = Math.min(...pts.map((p) => p.v), mode === "value" ? 0 : Infinity);
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || Math.abs(hi) || 1;
  const [y0, y1] = [lo - span * 0.08, hi + span * 0.1];
  const sx = (i: number) => pad.l + (cells.length === 1 ? 0 : (i / (cells.length - 1)) * (width - pad.l - pad.r));
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + (y1 - y0) * f);
  const yLabel = (v: number) => (mode === "value" ? fmt(v, unit, currency) : v.toFixed(0));
  const xy = cells.map((c) => {
    const v = y(c);
    return v == null ? null : ([sx(cells.indexOf(c)), sy(v)] as Pt);
  });
  const baseY = sy(Math.max(y0, Math.min(y1, mode === "value" ? 0 : y0)));
  const step = Math.max(1, Math.ceil(cells.length / 10));
  const hovered = hover != null ? cells[hover] : null;
  const last = pts[pts.length - 1];

  return (
    <div ref={wrap} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`${label} over ${cells.length} periods, ${mode === "value" ? "as reported" : "indexed to the first period = 100"}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const i = Math.round(((x - pad.l) / (width - pad.l - pad.r)) * (cells.length - 1));
          setHover(Math.max(0, Math.min(cells.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
            <text x={pad.l - 10} y={sy(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
              {yLabel(t)}
            </text>
          </g>
        ))}
        {mode !== "value" && y0 < 100 && y1 > 100 && (
          <line x1={pad.l} x2={width - pad.r} y1={sy(100)} y2={sy(100)} stroke="var(--line-strong)" strokeDasharray="3 4" />
        )}
        {cells.map((c, i) =>
          i % step === 0 || i === cells.length - 1 ? (
            <text key={c.period.end} x={sx(i)} y={H - 8} textAnchor="middle" className="fill-ink-3 text-[11px]">
              {periodLabel(c.period).replace("FY", "")}
            </text>
          ) : null,
        )}
        {/* Keyed so each new selection draws in again, left to right. */}
        <g key={`${label}-${mode}-${cells.length}`}>
          <path d={smoothArea(xy, baseY)} fill="var(--mint)" opacity={0.75} />
          <path d={smoothLine(xy)} pathLength={1} className="chart-draw" fill="none" stroke="var(--spruce)" strokeWidth={2} strokeLinecap="round" />
        </g>
        {hover != null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" />}
        {hover != null && hovered && y(hovered) != null && (
          <circle cx={sx(hover)} cy={sy(y(hovered)!)} r={4} fill="var(--panel)" stroke="var(--spruce)" strokeWidth={2} />
        )}
        <circle cx={sx(last.i)} cy={sy(last.v)} r={4.5} fill="var(--spruce)" stroke="var(--panel)" strokeWidth={2} />
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-48 rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] shadow-2"
          style={{ left: Math.min(Math.max(sx(hover!) - 96, 0), width - 192) }}
        >
          <div className="font-semibold text-ink">{periodLabel(hovered.period)}</div>
          <div className="font-mono text-[12px] text-ink-3">ended {hovered.period.end}</div>
          <div className="mt-1.5 flex justify-between gap-2">
            <span className="text-ink-3">Value</span>
            <span className="font-semibold text-ink">{fmt(hovered.value, unit, currency)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-3">Change</span>
            <Delta change={hovered.change} />
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-3">Index</span>
            <span className="text-ink">{hovered.index == null ? "—" : hovered.index.toFixed(1)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** "calc" marks a derived line item. */
function CalcTag() {
  return <span className="ml-1.5 rounded-xs bg-mint px-1 py-px align-middle font-mono text-[12px] font-medium text-mint-ink">calc</span>;
}

/** A percent change with its direction: ▲ gain / ▼ loss, never color alone. */
function Delta({ change, className = "", step = 0 }: { change: number | null; className?: string; step?: number }) {
  if (change == null) return <span className={`text-ink-3 ${className}`}>—</span>;
  const up = change >= 0;
  // On a heat square: ink on steps 2–3, the step's own on-color on step 4 (contrast first; ▲/▼ carry direction).
  const color = step === 4 ? (up ? "text-on-surge-4" : "text-on-drop-4") : step >= 2 ? "text-ink" : up ? "text-gain" : "text-loss";
  return (
    <span className={`whitespace-nowrap ${color} ${className}`}>
      <span aria-hidden>{up ? "▲" : "▼"}</span> {formatChange(change)}
    </span>
  );
}

// ── vertical analysis ────────────────────────────────────────────────────────

// Validated categorical palette (dataviz reference; --series-1..8 hold the light and dark steps, both checked
// against the panel color). A series keeps its slot while other selections change — color follows the line
// item, never its position.
const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const MAX_PICKS = SERIES_COLORS.length;
const MONEY_ROWS = ALL_ROWS.filter((r) => r.unit === "money");
const rowByKey = new Map(ALL_ROWS.map((r) => [r.key, r]));

const PRESETS: { key: string; label: string; base: string; items: string[]; hint: string }[] = [
  { key: "income", label: "Income statement", base: "revenue", items: ["cost_of_goods_sold", "gross_profit", "sga_expense", "operating_income", "net_income"], hint: "common-size: % of revenue" },
  { key: "balance", label: "Balance sheet", base: "total_assets", items: ["cash_and_equivalents", "accounts_receivable", "inventory", "current_assets", "total_liabilities", "stockholders_equity"], hint: "common-size: % of total assets" },
  { key: "cash", label: "Cash flow", base: "revenue", items: ["operating_cash_flow", "capital_expenditures", "free_cash_flow", "dividends_paid"], hint: "cash flows as % of revenue" },
  { key: "returns", label: "Returns", base: "stockholders_equity", items: ["net_income", "operating_income"], hint: "e.g. net income ÷ equity (ROE)" },
];

type Pick = { key: string; slot: number };

function pct(num: number | null, base: number | null): number | null {
  return num == null || base == null || base === 0 ? null : (num / base) * 100;
}

function VerticalChart({
  periods,
  series,
}: {
  periods: FinancialPeriod[];
  series: { key: string; label: string; color: string; dashed?: boolean; values: (number | null)[] }[];
}) {
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const H = 240;
  const labelRoom = series.length <= 4 ? 128 : 20; // direct labels at line ends when there are few series
  const pad = { l: 52, r: labelRoom, t: 14, b: 30 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (periods.length < 2 || all.length === 0) return <p className="py-8 text-center text-[13px] text-ink-3">Pick line items to compare.</p>;
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const [y0, y1] = [lo - span * 0.06, hi + span * 0.08];
  const sx = (i: number) => pad.l + (i / (periods.length - 1)) * (width - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + (y1 - y0) * f);
  const step = Math.max(1, Math.ceil(periods.length / 10));
  const line = (values: (number | null)[]) => smoothLine(values.map((v, i) => (v == null ? null : ([sx(i), sy(v)] as Pt))));

  return (
    <div ref={wrap} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Percent of base for ${series.map((s) => s.label).join(", ")} across ${periods.length} periods`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const i = Math.round(((x - pad.l) / (width - pad.l - pad.r)) * (periods.length - 1));
          setHover(Math.max(0, Math.min(periods.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
            <text x={pad.l - 10} y={sy(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
              {t.toFixed(0)}%
            </text>
          </g>
        ))}
        {y0 < 0 && y1 > 0 && <line x1={pad.l} x2={width - pad.r} y1={sy(0)} y2={sy(0)} stroke="var(--line-strong)" />}
        {periods.map((p, i) =>
          i % step === 0 || i === periods.length - 1 ? (
            <text key={p.end} x={sx(i)} y={H - 8} textAnchor="middle" className="fill-ink-3 text-[11px]">
              {periodLabel(p).replace("FY", "")}
            </text>
          ) : null,
        )}
        {series.map((s) =>
          s.dashed ? (
            <path key={s.key} d={line(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />
          ) : (
            <path key={s.key} d={line(s.values)} pathLength={1} className="chart-draw" fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" />
          ),
        )}
        {series.map((s) =>
          s.values.map((v, i) =>
            v == null ? null : (
              // A panel-colored ring keeps overlapping markers legible.
              <circle key={`${s.key}-${i}`} cx={sx(i)} cy={sy(v)} r={hover === i ? 4.5 : 2.5} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
            ),
          ),
        )}
        {series.length <= 4 &&
          series.map((s) => {
            const lastIdx = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
            if (lastIdx == null) return null;
            return (
              <text key={`lbl-${s.key}`} x={sx(lastIdx) + 10} y={sy(s.values[lastIdx]!) + 4} className="fill-ink-2 text-[12px] font-medium">
                {s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label}
              </text>
            );
          })}
        {hover != null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" />}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-60 rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] shadow-2"
          style={{ left: Math.min(Math.max(sx(hover) - 120, 0), width - 240) }}
        >
          <div className="mb-1 font-semibold text-ink">{periodLabel(periods[hover])}</div>
          {[...series]
            .sort((a, b) => (b.values[hover] ?? -Infinity) - (a.values[hover] ?? -Infinity))
            .map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-ink-3">
                  <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: s.color }} />
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="font-semibold text-ink">{s.values[hover] == null ? "—" : `${s.values[hover]!.toFixed(1)}%`}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function VerticalView({ periods, currency, periodType }: { periods: FinancialPeriod[]; currency: string; periodType: PeriodType }) {
  const reduceMotion = useReducedMotion();
  const [base, setBase] = useState("revenue");
  const [picks, setPicks] = useState<Pick[]>(() => PRESETS[0].items.map((key, slot) => ({ key, slot })));
  const [preset, setPreset] = useState<string | null>("income");
  // The sum only means something for a combination you build (COGS + SG&A), not for overlapping presets.
  const [showSum, setShowSum] = useState(false);

  // Only line items this company reports somewhere in the span.
  const available = useMemo(() => new Set(MONEY_ROWS.filter((r) => periods.some((p) => r.get(p) != null)).map((r) => r.key)), [periods]);
  const baseRow = rowByKey.get(base) ?? MONEY_ROWS[0];
  const shownPicks = picks.filter((p) => available.has(p.key) && p.key !== base);

  function applyPreset(key: string) {
    const pr = PRESETS.find((x) => x.key === key)!;
    setBase(pr.base);
    setPicks(pr.items.filter((k) => available.has(k)).slice(0, MAX_PICKS).map((k, slot) => ({ key: k, slot })));
    setPreset(key);
  }
  function toggle(key: string) {
    setPreset(null);
    setPicks((cur) => {
      if (cur.some((p) => p.key === key)) return cur.filter((p) => p.key !== key);
      if (cur.length >= MAX_PICKS) return cur;
      const used = new Set(cur.map((p) => p.slot));
      const slot = SERIES_COLORS.findIndex((_, i) => !used.has(i));
      return [...cur, { key, slot }];
    });
  }

  const rows = shownPicks.map((p) => {
    const row = rowByKey.get(p.key)!;
    return { ...p, row, values: periods.map((per) => pct(row.get(per), baseRow.get(per))) };
  });
  const combined =
    showSum && rows.length >= 2
      ? periods.map((per) => {
          const parts = rows.map((r) => r.row.get(per));
          return parts.some((v) => v == null) ? null : pct(parts.reduce((a, b) => a! + b!, 0), baseRow.get(per));
        })
      : null;
  type Series = { key: string; label: string; color: string; dashed?: boolean; values: (number | null)[] };
  const series: Series[] = [
    ...rows.map((r) => ({ key: r.key, label: r.row.label, color: SERIES_COLORS[r.slot], values: r.values })),
    ...(combined ? [{ key: "sum", label: "Σ selected", color: "var(--ink-2)", dashed: true, values: combined }] : []),
  ];
  const tableRows = [...rows.map((r) => ({ key: r.key, label: r.row.label, color: SERIES_COLORS[r.slot], values: r.values })), ...(combined ? [{ key: "sum", label: "Σ selected", color: "var(--ink-2)", values: combined }] : [])];
  const avg = (vs: (number | null)[]) => {
    const xs = vs.filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const shift = (vs: (number | null)[]) => {
    const xs = vs.filter((v): v is number => v != null);
    return xs.length >= 2 ? xs[xs.length - 1] - xs[0] : null;
  };

  return (
    <motion.div
      key="vertical"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={flow(2)}
      className="space-y-5"
    >
      {/* Presets + base */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow mr-1">Presets</span>
        {PRESETS.map((pr) => (
          <button
            key={pr.key}
            type="button"
            onClick={() => applyPreset(pr.key)}
            aria-pressed={preset === pr.key}
            title={pr.hint}
            className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors duration-[var(--dur-2)] ${
              preset === pr.key ? "border-transparent bg-mint text-mint-ink" : "border-line-strong bg-panel text-ink-2 hover:border-spruce hover:text-spruce"
            }`}
          >
            {pr.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[13px] font-semibold text-ink-2">
          Base (= 100%)
          <select
            value={base}
            onChange={(e) => {
              setBase(e.target.value);
              setPreset(null);
            }}
            className="field !py-1.5 font-semibold"
          >
            {SECTIONS.map((sec) => (
              <optgroup key={sec.key} label={sec.label}>
                {sec.rows
                  .filter((r) => r.unit === "money" && available.has(r.key))
                  .map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {/* Line-item picker */}
      <div className="space-y-3 rounded-md border border-line bg-canvas p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold text-ink">Line items as % of {baseRow.label}</span>
          <span className="flex items-center gap-3 text-[13px] text-ink-3">
            <label className={`flex items-center gap-1.5 ${shownPicks.length >= 2 ? "cursor-pointer text-ink-2" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={showSum}
                disabled={shownPicks.length < 2}
                onChange={(e) => setShowSum(e.target.checked)}
                className="size-3.5 accent-spruce"
              />
              Show Σ of selected
            </label>
            {shownPicks.length}/{MAX_PICKS} selected · click to add or remove
          </span>
        </div>
        {SECTIONS.map((sec) => {
          const options = sec.rows.filter((r) => r.unit === "money" && available.has(r.key));
          if (!options.length) return null;
          return (
            <div key={sec.key} className="flex flex-wrap items-center gap-1.5">
              <span className="eyebrow w-28 shrink-0">{sec.label.split(" ·")[0]}</span>
              {options.map((r) => {
                const pick = shownPicks.find((p) => p.key === r.key);
                const isBase = r.key === base;
                const full = !pick && shownPicks.length >= MAX_PICKS;
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => toggle(r.key)}
                    disabled={isBase || full}
                    aria-pressed={!!pick}
                    title={isBase ? "This is the base (100%)" : full ? `Up to ${MAX_PICKS} line items` : undefined}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] transition-colors duration-[var(--dur-2)] disabled:cursor-not-allowed disabled:opacity-45 ${
                      pick ? "border-line-strong bg-panel font-semibold text-ink shadow-1" : "border-line bg-transparent text-ink-2 hover:border-spruce hover:text-spruce"
                    }`}
                  >
                    {pick && <span aria-hidden className="size-2 rounded-full" style={{ background: SERIES_COLORS[pick.slot] }} />}
                    {r.label}
                    {isBase && <span className="rounded-xs bg-mint px-1 font-mono text-[12px] text-mint-ink">base</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Chart */}
      <div className="panel p-5">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color, opacity: s.dashed ? 0.8 : 1 }} />
              {s.label}
            </span>
          ))}
          <span className="ml-auto text-[13px] text-ink-3">% of {baseRow.label} · hover for details</span>
        </div>
        <VerticalChart periods={periods} series={series} />
      </div>

      {/* Table */}
      {tableRows.length > 0 && (
        <div className="panel overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[14px]">
            <thead>
              <tr>
                <th className={`${TH} sticky left-0 z-10 text-left`}>% of {baseRow.label}</th>
                {periods.map((p) => (
                  <th key={p.end} className={`${TH} text-right font-mono normal-case`}>
                    {periodLabel(p)}
                  </th>
                ))}
                <th className={`${TH} text-right`}>Average</th>
                <th className={`${TH} text-right`} title="Change from the first to the last period, in percentage points">
                  Shift (pp)
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => {
                const a = avg(r.values);
                const d = shift(r.values);
                return (
                  <tr key={r.key} className={`group ${r.key === "sum" ? "font-bold" : ""}`}>
                    <th scope="row" className={`${TD} sticky left-0 z-10 bg-panel text-left font-semibold whitespace-nowrap text-ink group-hover:bg-subtle ${r.key === "sum" ? "!border-t-ink-3" : ""}`}>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: r.color }} />
                        {r.label}
                      </span>
                    </th>
                    {r.values.map((v, i) => (
                      <td
                        key={periods[i].end}
                        className={`${TD} text-right whitespace-nowrap ${r.key === "sum" ? "!border-t-ink-3" : ""}`}
                        // Sequential (one hue) intensity by magnitude: how big a share of the base it is.
                        style={{ backgroundColor: v == null ? undefined : `color-mix(in srgb, var(--mint) ${Math.round(Math.min(Math.abs(v), 100))}%, transparent)` }}
                        title={`${periodLabel(periods[i])}: ${fmt(r.key === "sum" ? null : (rowByKey.get(r.key)?.get(periods[i]) ?? null), "money", currency)} of ${fmt(baseRow.get(periods[i]), "money", currency)}`}
                      >
                        <span className={`font-semibold tabular-nums ${v != null && v < 0 ? "text-loss" : "text-ink"}`}>{v == null ? "—" : v < 0 ? `(${Math.abs(v).toFixed(1)}%)` : `${v.toFixed(1)}%`}</span>
                      </td>
                    ))}
                    <td className={`${TD} text-right font-semibold text-ink tabular-nums group-hover:bg-subtle`}>{a == null ? "—" : `${a.toFixed(1)}%`}</td>
                    <td className={`${TD} text-right tabular-nums group-hover:bg-subtle`}>
                      {d == null ? <span className="text-ink-3">—</span> : (
                        <span className={d >= 0 ? "text-gain" : "text-loss"}>
                          {d >= 0 ? "▲" : "▼"} {d >= 0 ? "+" : "−"}
                          {Math.abs(d).toFixed(1)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[13px] leading-5 text-ink-3">
        Vertical analysis divides each selected line item by the base in the same {periodType === "annual" ? "fiscal year" : "quarter"}. Flows (income,
        cash flow) and period-end balances can be mixed — e.g. net income ÷ stockholders&apos; equity is return on equity. &ldquo;Show Σ of
        selected&rdquo; adds the picked items before dividing — useful for combinations like COGS + SG&amp;A (shown when every one is reported).
      </p>
    </motion.div>
  );
}

// ── card ────────────────────────────────────────────────────────────────────

/** CAGR tile: label → big figure (▲ gain / ▼ loss) → smooth sparkline of the line item. */
function CagrTile({ label, value, values }: { label: string; value: number | null; values: (number | null)[] }) {
  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="eyebrow truncate">{label}</div>
      <div className={`type-big-figure mt-1 ${value == null ? "text-ink-3" : value >= 0 ? "text-gain" : "text-loss"}`}>
        {value == null ? (
          "n/m"
        ) : (
          <>
            <span aria-hidden className="text-[16px]">{value >= 0 ? "▲" : "▼"}</span> {formatChange(value)}
          </>
        )}
      </div>
      <div className="mt-2">
        <Sparkline values={values} />
      </div>
    </div>
  );
}

function CompanyCard({ entry, periodType, defaultOpen }: { entry: CompanyEntry; periodType: PeriodType; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [years, setYears] = useState<5 | 10>(5);
  const [mode, setMode] = useState<Mode>("change");
  const [statement, setStatement] = useState<Statement>("all");
  const [analysis, setAnalysis] = useState<"horizontal" | "vertical">("horizontal");
  const [selected, setSelected] = useState("revenue");
  const reduceMotion = useReducedMotion();

  const fin = entry.financials!;
  const currency = fin.currency;
  const all = fin.periods; // newest first
  const perYear = periodType === "annual" ? 1 : 3; // 10-Qs: Q1–Q3 (Q4 is on the 10-K)
  const wanted = years * perYear;
  // Oldest → newest, so time reads left to right.
  const periods = useMemo(() => all.slice(0, wanted).reverse(), [all, wanted]);
  const short = all.length < wanted;
  // The form behind the figures: 10-K / 10-Q, or 20-F / 40-F for foreign filers, FMP for non-SEC data.
  const reportedForm = all[0]?.line_items.revenue?.form ?? all[0]?.line_items.net_income?.form;
  const form = reportedForm ? reportedForm.replace(/\/A$/, "") : periodType === "annual" ? "10-K" : "10-Q";
  const forms = /^(10-K|10-Q|20-F|40-F)$/.test(form) ? `${form}s` : "reports";

  // Rows with no value anywhere in the span are hidden (e.g. a bank has no inventory or COGS).
  const sections = useMemo(
    () =>
      SECTIONS.filter((sec) => statement === "all" || sec.key === statement)
        .map((sec) => ({
          ...sec,
          rows: sec.rows.map((r) => ({ row: r, cells: buildCells(periods, all, r, periodType) })).filter((r) => r.cells.some((c) => c.value != null)),
        }))
        .filter((sec) => sec.rows.length > 0),
    [statement, periods, all, periodType],
  );
  const sel = ALL_ROWS.find((r) => r.key === selected) ?? ALL_ROWS[0];
  const selCells = useMemo(() => buildCells(periods, all, sel, periodType), [periods, all, sel, periodType]);
  const headline = useMemo(
    () =>
      ["revenue", "net_income", "eps", "free_cash_flow"]
        .map((k) => ({ key: k, row: ALL_ROWS.find((r) => r.key === k)! }))
        .map(({ key, row }) => {
          const cells = buildCells(periods, all, row, periodType);
          return { key, label: row.label, cagr: cagr(cells), values: cells.map((c) => c.value) };
        }),
    [periods, all, periodType],
  );
  const first = periods[0];
  const last = periods[periods.length - 1];
  const id = `ha-${entry.id}`;
  const rowCount = sections.reduce((n, sec) => n + sec.rows.length, 0);

  return (
    <div className={`panel overflow-hidden ${open ? "" : "card-lift"}`}>
      <div className="space-y-4 p-6 max-sm:p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id}
          className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 text-left"
        >
          <motion.span
            aria-hidden
            animate={{ rotate: open ? 90 : 0 }}
            transition={flow(2)}
            className="grid size-8 place-items-center rounded-full bg-mint text-[16px] text-mint-ink"
          >
            ›
          </motion.span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[20px] leading-7 font-bold text-ink">{symbolOf(entry)}</div>
            <div className="truncate text-[13px] text-ink-3">{entry.profile?.name}</div>
          </div>
          <div className="text-right text-[13px] text-ink-3">
            <div className="font-mono text-ink-2">{first && last ? `${periodLabel(first)} → ${periodLabel(last)}` : "No history"}</div>
            <div>
              {periods.length} {forms} · {open ? "click to collapse" : "click to expand"}
            </div>
          </div>
        </button>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          {headline.map((h) => (
            <CagrTile key={h.key} label={`${h.label} CAGR`} value={h.cagr} values={h.values} />
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={flow(3)}
            className="overflow-hidden border-t border-line"
          >
            <div className="space-y-5 p-6 max-sm:p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  label="Analysis method"
                  value={analysis}
                  onChange={setAnalysis}
                  options={[
                    { key: "horizontal", label: "Horizontal", title: "Trend over time" },
                    { key: "vertical", label: "Vertical", title: "% of a base" },
                  ]}
                />
                <Segmented
                  label="Time span"
                  value={String(years) as "5" | "10"}
                  onChange={(v) => setYears(Number(v) as 5 | 10)}
                  options={[
                    { key: "5", label: periodType === "annual" ? "5 years" : "5 yrs · 15 Qs" },
                    { key: "10", label: periodType === "annual" ? "10 years" : "10 yrs · 30 Qs" },
                  ]}
                />
                {analysis === "horizontal" && (
                  <>
                    <Segmented label="Display" value={mode} onChange={setMode} options={MODES.map((m) => ({ key: m.key, label: m.label, title: m.hint }))} />
                    <Segmented label="Statement" value={statement} onChange={setStatement} options={STATEMENT_OPTIONS} />
                    <span className="ml-auto text-[13px] text-ink-3">{rowCount} line items</span>
                  </>
                )}
              </div>
              {short && (
                <p className="rounded-sm bg-caution-bg px-4 py-2 text-[13px] text-caution">
                  {entry.profile?.name ?? symbolOf(entry)} has {all.length} {periodType === "annual" ? "annual" : "quarterly"} reports ({forms}) on file so far —
                  showing all of them.
                </p>
              )}

              <AnimatePresence mode="wait" initial={false}>
                {analysis === "horizontal" ? (
                  <motion.div
                    key="horizontal"
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={flow(2)}
                    className="space-y-5"
                  >
              <div className="rounded-md border border-line bg-panel p-5">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="type-card text-ink">
                    {sel.label}
                    {sel.derived && <CalcTag />}
                  </h4>
                  <span className="text-[13px] text-ink-3">{mode === "value" ? `as reported, ${currency}` : "index · first period = 100 · hover for details"}</span>
                </div>
                <TrendChart cells={selCells} label={sel.label} mode={mode} unit={sel.unit} currency={currency} />
              </div>

              <div className="rounded-lg border border-line bg-panel shadow-1">
                <div className="overflow-x-auto rounded-lg">
                <table className="w-full border-separate border-spacing-0 text-[14px]">
                  <thead>
                    <tr>
                      <th className={`${TH} sticky left-0 z-20 text-left`}>Line item</th>
                      {periods.map((p) => (
                        <th key={p.end} className={`${TH} text-right font-mono normal-case`} title={`Period ended ${p.end}`}>
                          {periodLabel(p)}
                        </th>
                      ))}
                      <th className={`${TH} text-right`}>CAGR</th>
                    </tr>
                  </thead>
                  {sections.map((sec) => (
                    <tbody key={sec.key}>
                      <tr>
                        <th
                          colSpan={periods.length + 2}
                          scope="colgroup"
                          className="sticky left-0 border-t border-line bg-canvas px-4 py-2 text-left text-[11px] leading-4 font-bold tracking-[0.09em] text-spruce uppercase"
                        >
                          {sec.label}
                        </th>
                      </tr>
                      {sec.rows.map(({ row, cells }) => {
                        const growth = cagr(cells);
                        const active = row.key === sel.key;
                        // Accounting rules: a single rule above subtotals, a double rule under grand totals.
                        const rule = SUBTOTALS.has(row.key)
                          ? "!border-t-ink-3 font-semibold"
                          : GRAND_TOTALS.has(row.key)
                            ? "border-b-[3px] border-double border-b-spruce-strong font-bold"
                            : "";
                        const bg = active ? "bg-mint" : "bg-panel group-hover:bg-subtle";
                        return (
                          <tr key={row.key} onClick={() => setSelected(row.key)} aria-selected={active} className="group cursor-pointer">
                            <th
                              scope="row"
                              className={`${TD} ${rule} ${bg} sticky left-0 z-10 text-left whitespace-nowrap transition-colors duration-[var(--dur-1)] ${
                                active ? "text-mint-ink" : "text-ink"
                              } ${rule ? "" : "font-medium"}`}
                            >
                              {row.label}
                              {row.derived && <CalcTag />}
                            </th>
                            {cells.map((c, i) => {
                              const neg = c.value != null && c.value < 0 && row.unit !== "shares";
                              const h = mode === "change" ? heat(c.change) : null;
                              const up = (c.change ?? 0) >= 0;
                              const top =
                                mode === "index" ? (c.index == null ? "n/m" : c.index.toFixed(0)) : fmt(c.value, row.unit, currency);
                              return (
                                <td
                                  key={c.period.end}
                                  className={`${TD} ${rule} ${bg} text-right whitespace-nowrap transition-colors duration-[var(--dur-1)]`}
                                  title={`${periodLabel(c.period)}: ${fmt(c.value, row.unit, currency)}${c.change == null ? "" : ` · ${formatChange(c.change)} vs prior`}${c.index == null ? "" : ` · index ${c.index.toFixed(1)}`}`}
                                >
                                  <div
                                    className="-mx-2 -my-1 rounded-xs px-2 py-1 transition-colors duration-[var(--dur-2)]"
                                    style={h ? { backgroundColor: h.bg } : undefined}
                                  >
                                    <div
                                      className={`tabular-nums ${rule.includes("font-bold") ? "font-bold" : "font-semibold"} ${
                                        h?.step === 4
                                          ? up
                                            ? "text-on-surge-4"
                                            : "text-on-drop-4"
                                          : top === "n/m"
                                            ? "text-ink-3"
                                            : h && h.step >= 2
                                              ? "text-ink"
                                            : mode !== "index" && neg
                                              ? "text-loss"
                                              : "text-ink"
                                      }`}
                                    >
                                      {top}
                                    </div>
                                    {mode === "change" && (
                                      <div className="text-[12px] font-medium tabular-nums">
                                        {c.change == null ? (
                                          <span className="text-ink-3">{i === 0 && c.value != null ? "base" : "—"}</span>
                                        ) : (
                                          <Delta change={c.change} step={h?.step} />
                                        )}
                                      </div>
                                    )}
                                  {mode === "index" && <div className="text-[12px] text-ink-3 tabular-nums">{fmt(c.value, row.unit, currency)}</div>}
                                  </div>
                                </td>
                              );
                            })}
                            <td className={`${TD} ${rule} ${bg} text-right whitespace-nowrap tabular-nums transition-colors duration-[var(--dur-1)]`}>
                              {growth == null ? <span className="text-ink-3">n/m</span> : <Delta change={growth} className="font-semibold" />}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
                </div>
              </div>
              <p className="text-[13px] leading-5 text-ink-3">
                {periodType === "annual"
                  ? `Each fiscal year (${form}) is compared with the one before.`
                  : "Each quarter (10-Q) is compared with the same quarter a year earlier. Q4 has no 10-Q — it's in the annual 10-K; switch to Annual to include it. Q2/Q3 cash flows are year-to-date figures minus the prior quarter's."}{" "}
                Balance-sheet items are period-end balances; &ldquo;calc&rdquo; rows are derived (gross profit = revenue − COGS, EPS = net income ÷ diluted
                shares, using net income available to common shareholders when reported). Line items a company doesn&apos;t report are hidden. Click a row to chart it; n/m = not meaningful (negative or zero base).
              </p>
                  </motion.div>
                ) : (
                  <VerticalView periods={periods} currency={currency} periodType={periodType} />
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function HorizontalAnalysis({ entries, periodType, focusedId }: { entries: CompanyEntry[]; periodType: PeriodType; focusedId: string | null }) {
  const ready = entries.filter((e) => e.status === "ready" && e.financials && e.financials.period_type === periodType);
  if (ready.length === 0) return null;
  const openId = ready.some((e) => e.id === focusedId) ? focusedId : ready[0].id;
  return (
    <section id="horizontal-analysis" aria-labelledby="ha-title" className="scroll-mt-28 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow !text-spruce">Trend over time · {periodType === "annual" ? "annual reports" : "quarterly 10-Qs"}</div>
          <h2 id="ha-title" className="type-section mt-1 text-ink max-sm:!text-[24px] max-sm:!leading-[30px]">
            Horizontal &amp; vertical analysis
          </h2>
          <p className="mt-1 text-[15px] text-ink-3">
            Horizontal: every line item across 5–10 years. Vertical: any line items as a % of the base you choose.
          </p>
        </div>
        <span className="rounded-full bg-subtle px-3 py-1 text-[13px] font-semibold text-ink-2">
          {ready.length} {ready.length === 1 ? "company" : "companies"}
        </span>
      </div>
      <div className="space-y-6">
        {ready.map((e) => (
          <CompanyCard key={`${e.id}:${periodType}`} entry={e} periodType={periodType} defaultOpen={e.id === openId} />
        ))}
      </div>
    </section>
  );
}
