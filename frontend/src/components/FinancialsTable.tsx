"use client";

/**
 * Cross-sectional comparison matrix: one column per company, one row per line item,
 * audit ratio and forensic score. Each company's column is a single animated unit, so
 * adding a company slides its whole column in while the others glide aside.
 * Rows have fixed heights so values stay aligned across independently rendered columns.
 */

import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { FinancialPeriod, MetricKey, PeriodType, RatioKey, Variance } from "@/lib/api";
import { CompanyEntry, MAX_COMPARE, symbolOf } from "@/lib/comparisonStore";
import { formatChange, formatMoney, formatRatio, formatShares, periodLabel } from "@/lib/format";
import { BALANCE_SHEET_ROWS, CASH_FLOW_ROWS, INCOME_STATEMENT_ROWS, RATIO_ROWS } from "@/lib/metrics";
import { RATIO_LESSONS, findPriorYear, ratioInsight } from "@/lib/ratioInsights";
import { UnavailableButton } from "@/components/UnavailableButton";
import { TIER_LABELS, Tier, badgeClass, tierOf } from "@/lib/varianceStyle";

// ── badges & legend ─────────────────────────────────────────────────────────

function AlertIcon() {
  return (
    <svg viewBox="0 0 12 12" className="size-2.5 shrink-0" aria-hidden>
      <path d="M6 1 11.2 10.5H.8L6 1Z" fill="currentColor" opacity=".35" />
      <path d="M6 4.3v3M6 8.9v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function VarianceBadge({ direction, tier, pct }: { direction: "up" | "down"; tier: Tier; pct: number | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-[3px] font-mono text-[10.5px] leading-none font-semibold tabular-nums ring-1 ring-inset ${badgeClass(direction, tier)}`}
      aria-label={`${TIER_LABELS[tier].name} ${direction === "up" ? "increase" : "decrease"} ${pct == null ? "from zero" : formatChange(pct)}`}
    >
      {tier === 4 && <AlertIcon />}
      <span aria-hidden>{direction === "up" ? "▲" : "▼"}</span>
      {pct == null ? "new" : formatChange(pct)}
    </span>
  );
}

/** Compact key for the tier scale; drops on the left, surges mirrored on the right. */
export function VarianceLegend({ thresholdPct }: { thresholdPct: number }) {
  const tiers = [1, 2, 3, 4] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] text-ink-3">
      <span className="eyebrow">YoY variance &gt; ±{thresholdPct}%</span>
      {(["down", "up"] as const).map((direction) => (
        <span key={direction} className="flex items-center gap-1.5">
          <span className="mr-0.5">{direction === "down" ? "Drops" : "Surges"}</span>
          {tiers.map((t) => (
            <span
              key={t}
              title={`${TIER_LABELS[t].name}: ${TIER_LABELS[t].range}`}
              className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-[3px] font-mono text-[10px] leading-none ring-1 ring-inset ${badgeClass(direction, t)}`}
            >
              {t === 4 && <AlertIcon />}
              {TIER_LABELS[t].range}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

// ── row model ───────────────────────────────────────────────────────────────

type Row =
  | { kind: "section"; id: string; title: string }
  | { kind: "metric"; id: string; key: MetricKey; label: string; unit?: "shares" }
  | { kind: "ratio"; id: string; key: RatioKey; label: string; unit: "x" | "%"; formula?: string }
  | { kind: "piotroski" | "altman" | "sloan"; id: string; label: string; hint: string };

const ROWS: Row[] = [
  { kind: "section", id: "s-is", title: "Income Statement" },
  ...INCOME_STATEMENT_ROWS.map((r) => ({ kind: "metric" as const, id: r.key, ...r })),
  { kind: "section", id: "s-cf", title: "Cash Flow" },
  ...CASH_FLOW_ROWS.map((r) => ({ kind: "metric" as const, id: r.key, ...r })),
  { kind: "section", id: "s-bs", title: "Balance Sheet · period end" },
  ...BALANCE_SHEET_ROWS.map((r) => ({ kind: "metric" as const, id: r.key, ...r })),
  { kind: "section", id: "s-ratios", title: "Audit Ratios" },
  ...RATIO_ROWS.map((r) => ({ kind: "ratio" as const, id: r.key, ...r })),
  { kind: "section", id: "s-forensic", title: "Forensic Scores" },
  { kind: "piotroski", id: "piotroski", label: "Piotroski F-Score", hint: "0–9 strength signals · ≥ 7 strong, ≤ 3 weak" },
  { kind: "altman", id: "altman", label: "Altman Z''-Score", hint: "> 2.6 safe · 1.1–2.6 grey · < 1.1 distress" },
  { kind: "sloan", id: "sloan", label: "Sloan Accrual Ratio", hint: "(NI − CFO) ÷ avg assets · > 10% warns" },
];

const HEIGHT: Record<Row["kind"], string> = {
  section: "h-9",
  metric: "h-[54px]",
  ratio: "h-11",
  piotroski: "h-[54px]",
  altman: "h-[54px]",
  sloan: "h-[54px]",
};
const HEADER_H = "h-[92px]";

// ── cells ───────────────────────────────────────────────────────────────────

const ZONE_TEXT: Record<string, string> = {
  safe: "text-emerald-700 dark:text-emerald-400",
  strong: "text-emerald-700 dark:text-emerald-400",
  grey: "text-ink-3",
  neutral: "text-ink-3",
  normal: "text-ink-3",
  low: "text-ink-3",
  distress: "text-red-600 dark:text-red-400",
  weak: "text-red-600 dark:text-red-400",
  high: "text-orange-700 dark:text-orange-400",
};

function Zone({ zone, label }: { zone: string; label?: string }) {
  return <span className={`eyebrow ${ZONE_TEXT[zone] ?? "text-ink-3"}`}>{label ?? zone}</span>;
}

function variancesTitle(v: Variance | undefined, value: number, fmt: (n: number) => string): string {
  if (!v) return "";
  const prior = periodLabel({ fiscal_year: v.prior_fiscal_year, fiscal_period: v.prior_fiscal_period, end: v.prior_period_end });
  const tier = tierOf(v);
  return [
    `YoY vs ${prior}: ${fmt(v.prior_value)} → ${fmt(value)} (${v.change_pct == null ? "from 0" : formatChange(v.change_pct)})`,
    tier ? `${TIER_LABELS[tier].name} variance (${TIER_LABELS[tier].range})` : "Within materiality",
  ].join("\n");
}

/** Non-default reporting basis for a column: "EUR · IFRS", "JPY · FMP". US GAAP in USD shows nothing. */
function SourceTag({ financials }: { financials: CompanyEntry["financials"] }) {
  if (!financials) return null;
  const { source, currency, accounting_standard } = financials;
  if (source === "sec" && currency === "USD" && accounting_standard === "US GAAP") return null;
  const label = [currency, source === "fmp" ? "FMP" : accounting_standard].join(" · ");
  const detail =
    source === "fmp"
      ? "Financial Modeling Prep standardized statements (company not registered with the SEC)"
      : `SEC EDGAR ${accounting_standard} filings, reported in ${currency}`;
  return (
    <span className="font-mono text-[10px] tracking-wide whitespace-nowrap text-ink-3" title={detail}>
      {label}
    </span>
  );
}

/** Bare tags are US GAAP; IFRS tags and FMP fields arrive already qualified. */
function qualifiedTag(tag: string): string {
  return /[:.]/.test(tag) ? tag : `us-gaap:${tag}`;
}

function Cell({ row, period, currency }: { row: Row; period: FinancialPeriod | undefined; currency: string }): ReactNode {
  if (!period) return <span className="text-ink-4">—</span>;

  switch (row.kind) {
    case "section":
      return null;
    case "metric": {
      const item = period.line_items[row.key];
      const fmt = row.unit === "shares" ? formatShares : (v: number | null | undefined) => formatMoney(v, currency);
      if (!item)
        return (
          <span className="font-mono text-ink-4" title="Not reported">
            —
          </span>
        );
      const variance = period.variances[row.key];
      const tier = tierOf(variance);
      return (
        <div
          className="text-right"
          title={[qualifiedTag(item.source_tag), variancesTitle(variance, item.value, fmt)].filter(Boolean).join("\n")}
        >
          <div className={`font-mono tabular-nums ${item.value < 0 ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
            {fmt(item.value)}
          </div>
          {/* Badge slot is always reserved so values line up across columns whether or not they're flagged. */}
          <div className="mt-1 h-4">
            {tier && variance && variance.direction !== "flat" && (
              <VarianceBadge direction={variance.direction} tier={tier} pct={variance.change_pct} />
            )}
          </div>
        </div>
      );
    }
    case "ratio": {
      const ratio = period.ratios[row.key];
      if (!ratio)
        return (
          <span className="font-mono text-ink-4" title="Inputs not reported">
            —
          </span>
        );
      return (
        <span
          className={`font-mono tabular-nums ${ratio.value == null ? "text-ink-4" : "text-ink"}`}
          title={[ratio.formula, ratio.note].filter(Boolean).join("\n")}
        >
          {ratio.value == null ? "n/m" : formatRatio(ratio.value, row.unit)}
          {ratio.note && <span className="ml-0.5 text-ink-4">*</span>}
        </span>
      );
    }
    case "piotroski": {
      const f = period.forensics.piotroski;
      if (!f)
        return (
          <span className="text-[11px] text-ink-4" title={period.forensics.note ?? ""}>
            annual only
          </span>
        );
      const detail = f.signals.map((s) => `${s.passed == null ? "–" : s.passed ? "✓" : "✗"} ${s.label}`).join("\n");
      if (f.score == null) {
        return (
          <span className="text-[11px] text-ink-4" title={`Only ${f.available}/9 signals have data\n${detail}`}>
            insufficient data
          </span>
        );
      }
      const zone = f.score >= 7 ? "strong" : f.score <= 3 ? "weak" : "neutral";
      return (
        <div className="text-right" title={detail}>
          <div className="font-mono text-ink tabular-nums">
            {f.score}
            <span className="text-ink-4">/9</span>
          </div>
          <div className="mt-1 h-4 leading-4">
            <Zone zone={zone} />
          </div>
        </div>
      );
    }
    case "altman":
    case "sloan": {
      const s = row.kind === "altman" ? period.forensics.altman_z : period.forensics.sloan_accruals_pct;
      if (!s)
        return (
          <span className="text-[11px] text-ink-4" title={period.forensics.note ?? ""}>
            annual only
          </span>
        );
      if (s.value == null) return <span className="text-[11px] text-ink-4">{s.note ?? "n/a"}</span>;
      return (
        <div className="text-right">
          <div className="font-mono text-ink tabular-nums">{row.kind === "altman" ? s.value.toFixed(2) : formatChange(s.value)}</div>
          <div className="mt-1 h-4 leading-4">
            {s.zone && <Zone zone={s.zone} label={row.kind === "sloan" && s.zone === "high" ? "high accruals" : undefined} />}
          </div>
        </div>
      );
    }
  }
}

// ── ratio accordions ────────────────────────────────────────────────────────
// Each ratio row expands in every column at once. Each column's panel reports its natural height
// and the row animates to the tallest, so rows stay aligned across the label and company columns.

interface Accordion {
  open: Set<RatioKey>;
  toggle: (key: RatioKey) => void;
  heightOf: (key: RatioKey) => number | undefined;
  report: (key: RatioKey, slot: string, height: number) => void;
}

function useAccordion(): Accordion {
  const [open, setOpen] = useState<Set<RatioKey>>(new Set());
  const [heights, setHeights] = useState<Record<string, Record<string, number>>>({});
  const toggle = useCallback(
    (key: RatioKey) =>
      setOpen((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const report = useCallback(
    (key: RatioKey, slot: string, height: number) =>
      setHeights((h) => (h[key]?.[slot] === height ? h : { ...h, [key]: { ...h[key], [slot]: height } })),
    [],
  );
  const heightOf = (key: RatioKey) => {
    const all = Object.values(heights[key] ?? {});
    return all.length ? Math.max(...all) : undefined;
  };
  return { open, toggle, heightOf, report };
}

function ExpandSlot({ rowKey, slot, accordion, children }: { rowKey: RatioKey; slot: string; accordion: Accordion; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const open = accordion.open.has(rowKey);
  const { report } = accordion;

  useEffect(() => {
    const el = inner.current;
    if (!open || !el) return;
    const measure = () => report(rowKey, slot, el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      report(rowKey, slot, 0);
    };
  }, [open, rowKey, slot, report]);

  const height = accordion.heightOf(rowKey);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="panel"
          id={`ratio-${rowKey}-${slot}`}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: height ?? "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 34, opacity: { duration: 0.18 } }}
          className="overflow-hidden"
        >
          <div ref={inner} className="px-3.5 pb-3.5">
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 12 12"
      className="size-3 shrink-0 text-ink-4"
      animate={{ rotate: open ? 90 : 0 }}
      transition={{ duration: 0.18 }}
      aria-hidden
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </motion.svg>
  );
}

function RatioInsightPanel({
  rowKey,
  entry,
  period,
  others,
}: {
  rowKey: RatioKey;
  entry: CompanyEntry;
  period: FinancialPeriod | undefined;
  others: { symbol: string; value: number; peerGroup: string | null }[];
}) {
  if (!period || !entry.financials) return <p className="text-[11.5px] text-ink-4">No data for this period.</p>;
  const sentences = ratioInsight(rowKey, {
    symbol: symbolOf(entry),
    currency: entry.financials.currency,
    peerGroup: entry.profile?.peer_group ?? null,
    peerGroupLabel: entry.profile?.peer_group_label ?? null,
    period,
    prior: findPriorYear(period, entry.financials.periods),
    others,
  });
  return (
    // w-0 + min-w-full: the text wraps to the column instead of widening it (the matrix row is min-w-max,
    // so unwrapped sentences would otherwise stretch the column and push the others off-screen).
    <div className="w-0 min-w-full space-y-1.5 border-l-2 border-line-strong pl-2.5 text-left text-[11.5px] leading-relaxed text-ink-2">
      {sentences.map((t, i) => (
        <p key={i} className={i === 0 ? "text-ink" : undefined}>
          {t}
        </p>
      ))}
    </div>
  );
}

// ── columns ─────────────────────────────────────────────────────────────────

// Two-line rows (value + badge/zone) are top-aligned so the label sits level with the value.
const TWO_LINE = new Set<Row["kind"]>(["metric", "piotroski", "altman", "sloan"]);

function rowClass(row: Row, hovered: string | null) {
  const align = TWO_LINE.has(row.kind) ? "items-start pt-[9px]" : "items-center";
  const base = `${HEIGHT[row.kind]} flex ${align} border-b border-line px-3.5 transition-colors`;
  if (row.kind === "section") return `${base} bg-subtle/60`;
  return `${base} ${hovered === row.id ? "bg-subtle" : ""}`;
}

function CompanyColumn({
  entry,
  entries,
  offset,
  focused,
  hovered,
  onHover,
  onFocus,
  onRemove,
  accordion,
}: {
  entry: CompanyEntry;
  entries: CompanyEntry[];
  offset: number;
  focused: boolean;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onFocus: () => void;
  onRemove: () => void;
  accordion: Accordion;
}) {
  // The same ratio for the other loaded columns, for "highest of the companies compared".
  const othersFor = (key: RatioKey) =>
    entries
      .filter((e) => e.id !== entry.id && e.status === "ready")
      .flatMap((e) => {
        const value = e.financials?.periods[offset]?.ratios[key]?.value;
        return value == null ? [] : [{ symbol: symbolOf(e), value, peerGroup: e.profile?.peer_group ?? null }];
      });
  const period = entry.financials?.periods[offset];
  // Only rows the matrix shows: helper metrics (pre-tax income, tax) have variances too.
  const flags = period ? ROWS.filter((r) => r.kind === "metric" && period.variances[r.key]?.flagged).length : 0;
  const loading = entry.status === "loading";

  return (
    <div className="flex h-full flex-col">
      <div
        className={`${HEADER_H} group relative flex cursor-pointer flex-col justify-between border-b border-line px-3.5 py-3 ${focused ? "shadow-[inset_0_2px_0_var(--ink)]" : ""}`}
        onClick={onFocus}
        title={focused ? "Focused: drives valuation, news and narrative" : "Click to focus"}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* Shares a layoutId with the peer pill, so a clicked pill flies into this header. */}
            <div className="flex items-baseline gap-2">
              <motion.div layoutId={`company-${entry.id}`} className="w-fit font-mono text-base font-semibold tracking-tight text-ink">
                {symbolOf(entry)}
              </motion.div>
              <SourceTag financials={entry.financials} />
            </div>
            <div className="truncate text-[11px] text-ink-3">
              {entry.profile?.name ?? (entry.status === "error" ? (entry.unavailable ? "Unavailable" : "Not found") : "Loading…")}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove ${symbolOf(entry)} from comparison`}
            className="-mr-1 rounded-sm px-1.5 text-ink-4 transition-colors hover:bg-subtle hover:text-ink"
          >
            ×
          </button>
        </div>
        <div className="flex items-baseline justify-between font-mono text-[10.5px] text-ink-3">
          <span>{period ? `${periodLabel(period)} · ${period.end}` : loading ? "" : "no data"}</span>
          {flags > 0 && <span title="Material YoY variances in this period">{flags} flags</span>}
        </div>
      </div>

      {entry.status === "error" ? (
        entry.unavailable ? (
          // Needs an API key the site doesn't have: a neutral button that explains, not a raw error.
          <div className="flex-1 px-3.5 py-4">
            <UnavailableButton subject={symbolOf(entry)} />
          </div>
        ) : (
          <div className="flex-1 px-3.5 py-4 text-[13px] text-red-600 dark:text-red-400">{entry.error}</div>
        )
      ) : (
        ROWS.map((row) =>
          row.kind === "ratio" ? (
            <div
              key={row.id}
              className={`border-b border-line ${hovered === row.id ? "bg-subtle" : ""}`}
              onMouseEnter={() => onHover(row.id)}
            >
              <div
                className={`${HEIGHT.ratio} flex cursor-pointer items-center justify-end px-3.5`}
                onClick={() => !loading && accordion.toggle(row.key)}
                title={accordion.open.has(row.key) ? "Hide analysis" : "Show what this ratio means for this company"}
              >
                {loading ? (
                  <div className="h-3 w-20 animate-pulse rounded-sm bg-subtle" />
                ) : (
                  <Cell row={row} period={period} currency={entry.financials?.currency ?? "USD"} />
                )}
              </div>
              <ExpandSlot rowKey={row.key} slot={entry.id} accordion={accordion}>
                <RatioInsightPanel rowKey={row.key} entry={entry} period={period} others={othersFor(row.key)} />
              </ExpandSlot>
            </div>
          ) : (
            <div
              key={row.id}
              className={`${rowClass(row, hovered)} justify-end`}
              onMouseEnter={() => onHover(row.kind === "section" ? null : row.id)}
            >
              {loading ? (
                row.kind !== "section" && <div className="h-3 w-20 animate-pulse rounded-sm bg-subtle" />
              ) : (
                <Cell row={row} period={period} currency={entry.financials?.currency ?? "USD"} />
              )}
            </div>
          ),
        )
      )}
    </div>
  );
}

const OFFSETS = [0, 1, 2, 3, 4];

export function FinancialsTable({
  entries,
  focusedId,
  periodType,
  onFocus,
  onRemove,
  onAddClick,
}: {
  entries: CompanyEntry[];
  focusedId: string | null;
  periodType: PeriodType;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onAddClick: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const accordion = useAccordion();
  const reduceMotion = useReducedMotion();
  const unit = periodType === "annual" ? "Y" : "Q";
  const onHover = (row: Row) => setHovered(row.kind === "section" ? null : row.id);

  // "Liquid" entrance: a soft spring that slides, fades and un-blurs together.
  const spring = { type: "spring" as const, stiffness: 210, damping: 28, mass: 0.9 };
  const enter = reduceMotion ? { opacity: 0 } : { opacity: 0, x: 64, scale: 0.97, filter: "blur(8px)" };
  const exit = reduceMotion ? { opacity: 0 } : { opacity: 0, x: -32, scale: 0.97, filter: "blur(6px)" };

  return (
    <div className="panel overflow-x-auto" onMouseLeave={() => setHovered(null)}>
      <div className="flex min-w-max">
        {/* Label column */}
        <div className="sticky left-0 z-10 w-56 shrink-0 border-r border-line bg-panel">
          <div className={`${HEADER_H} flex flex-col justify-between border-b border-line px-3.5 py-3`}>
            <span className="eyebrow">Period</span>
            <div className="flex gap-0.5" role="group" aria-label="Period offset">
              {OFFSETS.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOffset(o)}
                  aria-pressed={offset === o}
                  className={`rounded-sm px-1.5 py-1 font-mono text-[10.5px] transition-colors ${offset === o ? "bg-inverse text-on-inverse" : "text-ink-3 hover:bg-subtle hover:text-ink"}`}
                >
                  {o === 0 ? "Latest" : `−${o}${unit}`}
                </button>
              ))}
            </div>
          </div>
          {ROWS.map((row) =>
            row.kind === "ratio" ? (
              <div
                key={row.id}
                className={`border-b border-line ${hovered === row.id ? "bg-subtle" : ""}`}
                onMouseEnter={() => onHover(row)}
              >
                <button
                  type="button"
                  onClick={() => accordion.toggle(row.key)}
                  aria-expanded={accordion.open.has(row.key)}
                  aria-controls={`ratio-${row.key}-label`}
                  className={`${HEIGHT.ratio} flex w-full items-center gap-2 px-3.5 text-left outline-none focus-visible:bg-subtle`}
                >
                  <Chevron open={accordion.open.has(row.key)} />
                  <span className="truncate text-[13px] text-ink">{row.label}</span>
                </button>
                <ExpandSlot rowKey={row.key} slot="label" accordion={accordion}>
                  <dl className="space-y-1.5 text-[11px] leading-snug">
                    <div>
                      <dt className="eyebrow">Formula</dt>
                      <dd className="font-mono text-[10.5px] text-ink-2">{RATIO_LESSONS[row.key].formula}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Where to find it</dt>
                      <dd className="text-ink-3">{RATIO_LESSONS[row.key].where}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">How to read it</dt>
                      <dd className="text-ink-3">{RATIO_LESSONS[row.key].readWith}</dd>
                    </div>
                  </dl>
                </ExpandSlot>
              </div>
            ) : (
              <div key={row.id} className={rowClass(row, hovered)} onMouseEnter={() => onHover(row)}>
                {row.kind === "section" ? (
                  <span className="eyebrow">{row.title}</span>
                ) : (
                  <div className="min-w-0" title={"hint" in row ? row.hint : undefined}>
                    <div className="truncate text-[13px] text-ink">{row.label}</div>
                    {"hint" in row && <div className="truncate text-[10px] text-ink-4">{row.hint}</div>}
                  </div>
                )}
              </div>
            ),
          )}
        </div>

        <LayoutGroup>
          <AnimatePresence mode="popLayout" initial={false}>
            {entries.map((entry, i) => (
              <motion.div
                key={entry.id}
                layout
                // Earlier columns stack above later ones, so a new column emerges from behind its
                // neighbours instead of sliding over their numbers while they resize.
                style={{ zIndex: MAX_COMPARE - i, position: "relative" }}
                initial={enter}
                animate={{ opacity: 1, x: 0, scale: 1, filter: "blur(0px)" }}
                exit={exit}
                transition={spring}
                className="w-[220px] shrink-0 grow border-r border-line bg-panel last:border-r-0 xl:w-auto xl:min-w-[200px] xl:basis-0"
              >
                <CompanyColumn
                  entry={entry}
                  entries={entries}
                  accordion={accordion}
                  offset={offset}
                  focused={entry.id === focusedId}
                  hovered={hovered}
                  onHover={setHovered}
                  onFocus={() => onFocus(entry.id)}
                  onRemove={() => onRemove(entry.id)}
                />
              </motion.div>
            ))}
            {entries.length < MAX_COMPARE && (
              <motion.button
                key="add-slot"
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                type="button"
                onClick={onAddClick}
                transition={spring}
                className="flex w-[180px] shrink-0 grow-0 flex-col items-center justify-center gap-1 border-l border-dashed border-line-strong text-ink-3 transition-colors hover:bg-subtle hover:text-ink"
              >
                <span className="text-xl leading-none">+</span>
                <span className="text-[12px]">Compare a company</span>
                <span className="font-mono text-[10.5px] text-ink-4">
                  {MAX_COMPARE - entries.length} slot{MAX_COMPARE - entries.length === 1 ? "" : "s"} left
                </span>
              </motion.button>
            )}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </div>
  );
}
