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
import { currencySymbol, formatChange, formatMoney, formatShares, periodLabel } from "@/lib/format";

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

function fmt(v: number | null, unit: Unit, currency: string): string {
  if (v == null) return "—";
  if (unit === "shares") return formatShares(v);
  if (unit === "perShare") return `${v < 0 ? "-" : ""}${currencySymbol(currency)}${Math.abs(v).toFixed(2)}`;
  return formatMoney(v, currency);
}

// Diverging tint: emerald for growth, rose for decline, transparent at zero; saturates at ±40%.
function tint(change: number | null): string | undefined {
  if (change == null) return undefined;
  const a = Math.min(Math.abs(change), 40) / 40;
  return change >= 0 ? `rgba(52, 211, 153, ${0.06 + a * 0.3})` : `rgba(251, 113, 133, ${0.06 + a * 0.3})`;
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
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // % change plots the index (a level), so the line stays readable; the tooltip carries the change.
  const y = (c: Cell) => (mode === "value" ? c.value : c.index);
  const pts = cells.map((c, i) => ({ i, c, v: y(c) })).filter((p): p is { i: number; c: Cell; v: number } => p.v != null);
  const H = 190;
  const pad = { l: 64, r: 30, t: 14, b: 26 };
  if (pts.length < 2) return <p className="py-6 text-center text-[12px] text-ink-3">Not enough history to chart {label}.</p>;

  const lo = Math.min(...pts.map((p) => p.v), mode === "value" ? 0 : Infinity);
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || Math.abs(hi) || 1;
  const [y0, y1] = [lo - span * 0.08, hi + span * 0.08];
  const sx = (i: number) => pad.l + (cells.length === 1 ? 0 : (i / (cells.length - 1)) * (width - pad.l - pad.r));
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const yLabel = (v: number) => (mode === "value" ? fmt(v, unit, currency) : v.toFixed(0));
  const path = pts.map((p, k) => `${k ? "L" : "M"}${sx(p.i).toFixed(1)},${sy(p.v).toFixed(1)}`).join("");
  const step = Math.max(1, Math.ceil(cells.length / 10));
  const hovered = hover != null ? cells[hover] : null;

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
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="rgba(255,255,255,0.06)" />
            <text x={pad.l - 8} y={sy(t) + 3.5} textAnchor="end" className="fill-[#7d8590] font-mono text-[10px]">
              {yLabel(t)}
            </text>
          </g>
        ))}
        {mode !== "value" && y0 < 100 && y1 > 100 && (
          <line x1={pad.l} x2={width - pad.r} y1={sy(100)} y2={sy(100)} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
        )}
        {cells.map((c, i) =>
          i % step === 0 || i === cells.length - 1 ? (
            <text key={c.period.end} x={sx(i)} y={H - 8} textAnchor="middle" className="fill-[#7d8590] font-mono text-[10px]">
              {periodLabel(c.period).replace("FY", "")}
            </text>
          ) : null,
        )}
        <motion.path
          d={path}
          fill="none"
          stroke="#00f0ff"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={reduceMotion ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
          key={`${label}-${mode}-${cells.length}`}
        />
        {pts.map((p) => (
          <circle key={p.i} cx={sx(p.i)} cy={sy(p.v)} r={hover === p.i ? 5 : 3} fill="#0a0b0d" stroke="#00f0ff" strokeWidth={2} />
        ))}
        {hover != null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.3)" />}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-44 rounded-md border border-white/10 bg-[#121418]/95 px-2.5 py-2 text-[11px] shadow-xl"
          style={{ left: Math.min(Math.max(sx(hover!) - 88, 0), width - 176) }}
        >
          <div className="font-semibold text-ink">{periodLabel(hovered.period)}</div>
          <div className="text-ink-4">ended {hovered.period.end}</div>
          <div className="mt-1 flex justify-between gap-2">
            <span className="text-ink-3">Value</span>
            <span className="font-mono text-ink">{fmt(hovered.value, unit, currency)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-3">Change</span>
            <span className="font-mono text-ink">{hovered.change == null ? "—" : `${hovered.change >= 0 ? "▲" : "▼"} ${formatChange(hovered.change)}`}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-ink-3">Index</span>
            <span className="font-mono text-ink">{hovered.index == null ? "—" : hovered.index.toFixed(1)}</span>
          </div>
        </div>
      )}
    </div>
  );
}


// ── vertical analysis ────────────────────────────────────────────────────────

// Validated categorical palette (dataviz reference, dark steps; all checks pass on #121418). A series keeps its
// slot while other selections change — color follows the line item, never its position.
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
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
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 220;
  const labelRoom = series.length <= 4 ? 120 : 16; // direct labels at line ends when there are few series
  const pad = { l: 48, r: labelRoom, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (periods.length < 2 || all.length === 0) return <p className="py-6 text-center text-[12px] text-ink-3">Pick line items to compare.</p>;
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const [y0, y1] = [lo - span * 0.06, hi + span * 0.08];
  const sx = (i: number) => pad.l + (i / (periods.length - 1)) * (width - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + (y1 - y0) * f);
  const step = Math.max(1, Math.ceil(periods.length / 10));
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

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
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="rgba(255,255,255,0.06)" />
            <text x={pad.l - 8} y={sy(t) + 3.5} textAnchor="end" className="fill-[#7d8590] font-mono text-[10px]">
              {t.toFixed(0)}%
            </text>
          </g>
        ))}
        {y0 < 0 && y1 > 0 && <line x1={pad.l} x2={width - pad.r} y1={sy(0)} y2={sy(0)} stroke="rgba(255,255,255,0.25)" />}
        {periods.map((p, i) =>
          i % step === 0 || i === periods.length - 1 ? (
            <text key={p.end} x={sx(i)} y={H - 8} textAnchor="middle" className="fill-[#7d8590] font-mono text-[10px]">
              {periodLabel(p).replace("FY", "")}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <motion.path
            key={s.key}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          />
        ))}
        {series.map((s) =>
          s.values.map((v, i) =>
            v == null ? null : (
              // 2px surface ring keeps overlapping markers legible.
              <circle key={`${s.key}-${i}`} cx={sx(i)} cy={sy(v)} r={hover === i ? 4.5 : 2.5} fill={s.color} stroke="#121418" strokeWidth={2} />
            ),
          ),
        )}
        {series.length <= 4 &&
          series.map((s) => {
            const lastIdx = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
            if (lastIdx == null) return null;
            return (
              <text key={`lbl-${s.key}`} x={sx(lastIdx) + 8} y={sy(s.values[lastIdx]!) + 3.5} className="fill-[#c9d1d9] text-[10.5px]">
                {s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label}
              </text>
            );
          })}
        {hover != null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.3)" />}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-56 rounded-md border border-white/10 bg-[#121418]/95 px-2.5 py-2 text-[11px] shadow-xl"
          style={{ left: Math.min(Math.max(sx(hover) - 112, 0), width - 224) }}
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
                <span className="font-mono text-ink">{s.values[hover] == null ? "—" : `${s.values[hover]!.toFixed(1)}%`}</span>
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
    ...(combined ? [{ key: "sum", label: "Σ selected", color: "#e6edf3", dashed: true, values: combined }] : []),
  ];
  const tableRows = [...rows.map((r) => ({ key: r.key, label: r.row.label, color: SERIES_COLORS[r.slot], values: r.values })), ...(combined ? [{ key: "sum", label: "Σ selected", color: "#e6edf3", values: combined }] : [])];
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
      transition={{ duration: 0.2 }}
      className="space-y-4"
    >
      {/* Presets + base */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-ink-4">Presets</span>
        {PRESETS.map((pr) => (
          <button
            key={pr.key}
            type="button"
            onClick={() => applyPreset(pr.key)}
            aria-pressed={preset === pr.key}
            title={pr.hint}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition ${
              preset === pr.key ? "bg-macropulse-cyan/15 text-macropulse-cyan ring-macropulse-cyan/40" : "text-ink-3 ring-white/10 hover:text-ink"
            }`}
          >
            {pr.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[11.5px] text-ink-3">
          Base (= 100%)
          <select
            value={base}
            onChange={(e) => {
              setBase(e.target.value);
              setPreset(null);
            }}
            className="h-8 rounded-md bg-black/40 px-2 text-[12px] text-ink ring-1 ring-white/10 outline-none ring-inset focus:ring-macropulse-cyan"
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
      <div className="space-y-2 rounded-lg border border-white/5 bg-black/20 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11.5px] font-medium text-ink-2">Line items as % of {baseRow.label}</span>
          <span className="flex items-center gap-3 text-[10.5px] text-ink-4">
            <label className={`flex items-center gap-1.5 ${shownPicks.length >= 2 ? "cursor-pointer text-ink-3" : "opacity-40"}`}>
              <input
                type="checkbox"
                checked={showSum}
                disabled={shownPicks.length < 2}
                onChange={(e) => setShowSum(e.target.checked)}
                className="size-3.5 accent-cyan-400"
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
              <span className="w-24 shrink-0 text-[10px] tracking-wide text-ink-4 uppercase">{sec.label.split(" ·")[0]}</span>
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
                    className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 ring-inset transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      pick ? "bg-white/[0.06] text-ink ring-white/20" : "text-ink-3 ring-white/10 hover:text-ink"
                    }`}
                  >
                    {pick && <span aria-hidden className="size-2 rounded-full" style={{ background: SERIES_COLORS[pick.slot] }} />}
                    {r.label}
                    {isBase && <span className="text-[9.5px] text-ink-4">base</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-white/5 bg-black/25 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-2">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color, opacity: s.dashed ? 0.8 : 1 }} />
              {s.label}
            </span>
          ))}
          <span className="ml-auto text-[10.5px] text-ink-4">% of {baseRow.label} · hover for details</span>
        </div>
        <VerticalChart periods={periods} series={series} />
      </div>

      {/* Table */}
      {tableRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-white/5 ring-inset">
          <table className="w-full border-separate border-spacing-0 text-[11.5px]">
            <thead>
              <tr className="text-ink-4">
                <th className="sticky left-0 z-10 bg-[#0f1114] px-3 py-2 text-left font-medium">% of {baseRow.label}</th>
                {periods.map((p) => (
                  <th key={p.end} className="bg-[#0f1114] px-2.5 py-2 text-right font-mono font-medium whitespace-nowrap">
                    {periodLabel(p)}
                  </th>
                ))}
                <th className="bg-[#0f1114] px-3 py-2 text-right font-medium whitespace-nowrap">Average</th>
                <th className="bg-[#0f1114] px-3 py-2 text-right font-medium whitespace-nowrap" title="Change from the first to the last period, in percentage points">
                  Shift (pp)
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => {
                const a = avg(r.values);
                const d = shift(r.values);
                return (
                  <tr key={r.key} className={r.key === "sum" ? "font-semibold" : ""}>
                    <th scope="row" className="sticky left-0 z-10 border-t border-white/5 bg-[#0f1114] px-3 py-1.5 text-left font-medium whitespace-nowrap text-ink-2">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: r.color }} />
                        {r.label}
                      </span>
                    </th>
                    {r.values.map((v, i) => (
                      <td
                        key={periods[i].end}
                        className="border-t border-white/5 px-2.5 py-1.5 text-right whitespace-nowrap"
                        // Sequential (one hue) intensity by magnitude: how big a share of the base it is.
                        style={{ backgroundColor: v == null ? undefined : `rgba(0,240,255,${Math.min(Math.abs(v), 100) / 100 * 0.22})` }}
                        title={`${periodLabel(periods[i])}: ${fmt(r.key === "sum" ? null : (rowByKey.get(r.key)?.get(periods[i]) ?? null), "money", currency)} of ${fmt(baseRow.get(periods[i]), "money", currency)}`}
                      >
                        <span className="font-mono text-ink tabular-nums">{v == null ? "—" : `${v.toFixed(1)}%`}</span>
                      </td>
                    ))}
                    <td className="border-t border-white/5 px-3 py-1.5 text-right font-mono text-ink tabular-nums">{a == null ? "—" : `${a.toFixed(1)}%`}</td>
                    <td className="border-t border-white/5 px-3 py-1.5 text-right font-mono tabular-nums">
                      {d == null ? <span className="text-ink-4">—</span> : (
                        <span className="text-ink">
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
      <p className="text-[10.5px] leading-snug text-ink-4">
        Vertical analysis divides each selected line item by the base in the same {periodType === "annual" ? "fiscal year" : "quarter"}. Flows (income,
        cash flow) and period-end balances can be mixed — e.g. net income ÷ stockholders&apos; equity is return on equity. &ldquo;Show Σ of
        selected&rdquo; adds the picked items before dividing — useful for combinations like COGS + SG&amp;A (shown when every one is reported).
      </p>
    </motion.div>
  );
}

// ── card ────────────────────────────────────────────────────────────────────

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: string; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-black/30 p-0.5 ring-1 ring-line ring-inset">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
          className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition ${
            value === o.key ? "bg-macropulse-cyan/15 text-macropulse-cyan ring-1 ring-macropulse-cyan/40 ring-inset" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md bg-white/[0.03] px-2.5 py-1.5 ring-1 ring-white/5 ring-inset">
      <div className="text-[10px] tracking-wide text-ink-4 uppercase">{label}</div>
      <div className={`font-mono text-[13px] font-semibold tabular-nums ${value == null ? "text-ink-4" : "text-ink"}`}>
        {value == null ? "n/m" : (
          <>
            <span aria-hidden className={value >= 0 ? "text-macropulse-neon-green" : "text-rose-400"}>
              {value >= 0 ? "▲" : "▼"}
            </span>{" "}
            {formatChange(value)}
          </>
        )}
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
    () => ["revenue", "net_income", "eps", "free_cash_flow"].map((k) => ({ key: k, row: ALL_ROWS.find((r) => r.key === k)! })).map(({ key, row }) => ({ key, label: row.label, cagr: cagr(buildCells(periods, all, row, periodType)) })),
    [periods, all, periodType],
  );
  const first = periods[0];
  const last = periods[periods.length - 1];
  const id = `ha-${entry.id}`;
  const rowCount = sections.reduce((n, sec) => n + sec.rows.length, 0);

  return (
    <div className={`overflow-hidden rounded-xl border bg-macropulse-panel backdrop-blur-md transition-colors ${open ? "border-macropulse-cyan/30" : "border-white/5 hover:border-white/15"}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5 text-left"
      >
        <div className="flex min-w-36 items-center gap-3">
          <span aria-hidden className={`grid size-7 place-items-center rounded-md text-[13px] text-macropulse-cyan ring-1 ring-macropulse-cyan/40 transition-transform ${open ? "rotate-90" : ""}`}>
            ›
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[15px] font-bold text-white">{symbolOf(entry)}</div>
            <div className="max-w-48 truncate text-[11px] text-ink-3">{entry.profile?.name}</div>
          </div>
        </div>
        <div className="flex flex-1 flex-wrap gap-2">
          {headline.map((h) => (
            <Stat key={h.key} label={`${h.label} CAGR`} value={h.cagr} />
          ))}
        </div>
        <div className="text-right text-[11px] text-ink-3">
          <div className="font-mono text-ink-2">{first && last ? `${periodLabel(first)} → ${periodLabel(last)}` : "No history"}</div>
          <div>
            {periods.length} {forms} · {open ? "click to collapse" : "click to expand"}
          </div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div role="radiogroup" aria-label="Analysis method" className="inline-flex rounded-xl bg-black/40 p-1 ring-1 ring-macropulse-cyan/25 ring-inset">
                  {(
                    [
                      ["horizontal", "Horizontal", "trend over time"],
                      ["vertical", "Vertical", "% of a base"],
                    ] as const
                  ).map(([key, label, sub]) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={analysis === key}
                      onClick={() => setAnalysis(key)}
                      className={`relative rounded-lg px-3.5 py-1.5 text-left transition ${analysis === key ? "text-black" : "text-ink-3 hover:text-ink"}`}
                    >
                      {analysis === key && (
                        <motion.span
                          layoutId={`ha-method-${entry.id}`}
                          className="absolute inset-0 rounded-lg bg-macropulse-cyan shadow-[0_0_14px_rgba(0,240,255,0.45)]"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        />
                      )}
                      <span className="relative block text-[12px] font-semibold">{label}</span>
                      <span className={`relative block text-[10px] ${analysis === key ? "text-black/70" : "text-ink-4"}`}>{sub}</span>
                    </button>
                  ))}
                </div>
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
                    <span className="ml-auto text-[11px] text-ink-4">{rowCount} line items</span>
                  </>
                )}
              </div>
              {short && (
                <p className="rounded-md bg-macropulse-neon-amber/10 px-3 py-1.5 text-[11.5px] text-amber-200 ring-1 ring-macropulse-neon-amber/25 ring-inset">
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
                    transition={{ duration: 0.2 }}
                    className="space-y-4"
                  >
              <div className="rounded-lg border border-white/5 bg-black/25 p-3">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <h4 className="text-[13px] font-semibold text-ink">
                    {sel.label}
                    {sel.derived && <span className="ml-1.5 text-[10.5px] font-normal text-ink-4">derived</span>}
                  </h4>
                  <span className="text-[10.5px] text-ink-4">{mode === "value" ? `as reported, ${currency}` : "index · first period = 100 · hover for details"}</span>
                </div>
                <TrendChart cells={selCells} label={sel.label} mode={mode} unit={sel.unit} currency={currency} />
              </div>

              <div className="overflow-x-auto rounded-lg ring-1 ring-white/5 ring-inset">
                <table className="w-full border-separate border-spacing-0 text-[11.5px]">
                  <thead className="sticky top-0 z-20">
                    <tr className="text-ink-4">
                      <th className="sticky left-0 z-30 bg-[#0f1114] px-3 py-2 text-left font-medium">Line item</th>
                      {periods.map((p) => (
                        <th key={p.end} className="bg-[#0f1114] px-2.5 py-2 text-right font-mono font-medium whitespace-nowrap" title={`Period ended ${p.end}`}>
                          {periodLabel(p)}
                        </th>
                      ))}
                      <th className="bg-[#0f1114] px-3 py-2 text-right font-medium whitespace-nowrap">CAGR</th>
                    </tr>
                  </thead>
                  {sections.map((sec) => (
                    <tbody key={sec.key}>
                      <tr>
                        <th
                          colSpan={periods.length + 2}
                          scope="colgroup"
                          className="sticky left-0 border-t border-white/5 bg-[#0c0d10] px-3 py-1.5 text-left text-[10px] font-semibold tracking-[0.14em] text-macropulse-cyan/80 uppercase"
                        >
                          {sec.label}
                        </th>
                      </tr>
                      {sec.rows.map(({ row, cells }) => {
                        const growth = cagr(cells);
                        const active = row.key === sel.key;
                        return (
                          <tr
                            key={row.key}
                            onClick={() => setSelected(row.key)}
                            aria-selected={active}
                            className={`group cursor-pointer transition-colors ${active ? "bg-macropulse-cyan/[0.07]" : "hover:bg-white/[0.03]"}`}
                          >
                            <th
                              scope="row"
                              className={`sticky left-0 z-10 border-t border-white/5 px-3 py-1.5 text-left font-medium whitespace-nowrap transition-colors ${
                                active ? "bg-[#0f1a1d] text-macropulse-cyan" : "bg-[#0f1114] text-ink-2 group-hover:text-ink"
                              }`}
                            >
                              {row.label}
                              {row.derived && <span className="ml-1 text-[9.5px] font-normal text-ink-4">calc</span>}
                            </th>
                            {cells.map((c, i) => {
                              const main =
                                mode === "value"
                                  ? fmt(c.value, row.unit, currency)
                                  : mode === "index"
                                    ? c.index == null
                                      ? "n/m"
                                      : c.index.toFixed(0)
                                    : c.change == null
                                      ? i === 0 && c.value != null
                                        ? "base"
                                        : "—"
                                      : `${c.change >= 0 ? "▲" : "▼"} ${formatChange(c.change)}`;
                              return (
                                <motion.td
                                  key={c.period.end}
                                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.4), duration: 0.25 }}
                                  style={{ backgroundColor: mode === "change" ? tint(c.change) : undefined }}
                                  className="border-t border-white/5 px-2.5 py-1.5 text-right whitespace-nowrap"
                                  title={`${periodLabel(c.period)}: ${fmt(c.value, row.unit, currency)}${c.change == null ? "" : ` · ${formatChange(c.change)} vs prior`}${c.index == null ? "" : ` · index ${c.index.toFixed(1)}`}`}
                                >
                                  <div className="font-mono text-ink tabular-nums">{main}</div>
                                  {mode !== "value" && <div className="font-mono text-[10px] text-ink-4 tabular-nums">{fmt(c.value, row.unit, currency)}</div>}
                                </motion.td>
                              );
                            })}
                            <td className="border-t border-white/5 px-3 py-1.5 text-right font-mono whitespace-nowrap text-ink tabular-nums">
                              {growth == null ? <span className="text-ink-4">n/m</span> : formatChange(growth)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </div>
              <p className="text-[10.5px] leading-snug text-ink-4">
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
    <section id="horizontal-analysis" aria-labelledby="ha-title" className="scroll-mt-28 space-y-4 rounded-2xl border border-macropulse-cyan/15 bg-gradient-to-b from-macropulse-cyan/[0.05] to-transparent p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-1 h-9 w-1 rounded-full bg-macropulse-cyan shadow-[0_0_14px_rgba(0,240,255,0.6)]" />
          <div>
            <div className="eyebrow text-macropulse-cyan/80">Trend over time · {periodType === "annual" ? "annual reports" : "quarterly 10-Qs"}</div>
            <h2 id="ha-title" className="mt-0.5 text-xl font-semibold tracking-tight text-white">
              Horizontal &amp; Vertical Analysis
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              Horizontal: every line item across 5–10 years. Vertical: any line items as a % of the base you choose.
            </p>
          </div>
        </div>
        <span className="rounded-full bg-white/[0.04] px-3 py-1 text-[11px] text-ink-3 ring-1 ring-white/10 ring-inset">
          {ready.length} {ready.length === 1 ? "company" : "companies"}
        </span>
      </div>
      <div className="space-y-2.5">
        {ready.map((e) => (
          <CompanyCard key={`${e.id}:${periodType}`} entry={e} periodType={periodType} defaultOpen={e.id === openId} />
        ))}
      </div>
    </section>
  );
}
