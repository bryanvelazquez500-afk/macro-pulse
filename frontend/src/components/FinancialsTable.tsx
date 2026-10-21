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
import { formatAccounting, formatChange, formatMoney, formatRatio, formatShares, periodLabel } from "@/lib/format";
import { ledgerRule } from "@/lib/ledger";
import { flow } from "@/lib/motion";
import { BALANCE_SHEET_ROWS, CASH_FLOW_ROWS, INCOME_STATEMENT_ROWS, RATIO_ROWS } from "@/lib/metrics";
import { RATIO_LESSONS, findPriorYear, ratioInsight } from "@/lib/ratioInsights";
import { Segmented } from "@/components/Segmented";
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
      className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] leading-none font-semibold tabular-nums ring-1 ring-inset ${badgeClass(direction, tier)}`}
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
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
      <span className="eyebrow">YoY variance &gt; ±{thresholdPct}%</span>
      {(["down", "up"] as const).map((direction) => (
        <span key={direction} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5">{direction === "down" ? "Drops" : "Surges"}</span>
          {tiers.map((t) => (
            <span
              key={t}
              title={`${TIER_LABELS[t].name}: ${TIER_LABELS[t].range}`}
              className={`inline-flex items-center gap-1 rounded-xs px-2 py-1 text-[11px] leading-none font-semibold whitespace-nowrap ring-1 ring-inset ${badgeClass(direction, t)}`}
            >
              {t === 4 && <AlertIcon />}
              <span aria-hidden>{direction === "up" ? "▲" : "▼"}</span>
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
  section: "h-10",
  metric: "h-[54px]",
  ratio: "h-11",
  piotroski: "h-[54px]",
  altman: "h-[54px]",
  sloan: "h-[54px]",
};
const HEADER_H = "h-[112px]";

// ── cells ───────────────────────────────────────────────────────────────────

// Forensic zones as status pills: strong/safe → gain, grey → caution, weak/distress/warn → loss, else neutral.
const ZONE_PILL: Record<string, string> = {
  safe: "bg-gain-bg text-gain",
  strong: "bg-gain-bg text-gain",
  grey: "bg-caution-bg text-caution",
  distress: "bg-loss-bg text-loss",
  weak: "bg-loss-bg text-loss",
  high: "bg-loss-bg text-loss",
};

function Zone({ zone, label }: { zone: string; label?: string }) {
  return <span className={`pill ${ZONE_PILL[zone] ?? "bg-subtle text-ink-2"}`}>{label ?? zone}</span>;
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
    <span className="text-[11px] font-semibold tracking-wide whitespace-nowrap text-ink-3" title={detail}>
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
      const show = row.unit === "shares" ? formatShares : (v: number | null | undefined) => formatAccounting(v, currency);
      if (!item)
        return (
          <span className="text-ink-4" title="Not reported">
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
          <div className={`text-[14px] leading-5 tabular-nums ${item.value < 0 ? "text-loss" : "text-ink"} ${ledgerRule(row.key) ? "" : "font-semibold"}`}>
            {show(item.value)}
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
          <span className="text-ink-4" title="Inputs not reported">
            —
          </span>
        );
      return (
        <span
          className={`text-[14px] font-semibold tabular-nums ${ratio.value == null ? "text-ink-3" : "text-ink"}`}
          title={[ratio.formula, ratio.note].filter(Boolean).join("\n")}
        >
          {ratio.value == null ? "n/m" : formatRatio(ratio.value, row.unit)}
          {ratio.note && <span className="ml-0.5 text-ink-3">*</span>}
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
      const zone = f.score >= 7 ? "strong" : f.score <= 3 ? "weak" : "normal";
      return (
        <div className="text-right" title={detail}>
          <div className="text-[14px] font-semibold text-ink tabular-nums">
            {f.score}
            <span className="text-ink-3">/9</span>
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
          <div className="text-[14px] font-semibold text-ink tabular-nums">{row.kind === "altman" ? s.value.toFixed(2) : formatChange(s.value)}</div>
          <div className="mt-1 h-4 leading-4">
            {s.zone && <Zone zone={s.zone} label={row.kind === "sloan" && s.zone === "high" ? "warn" : undefined} />}
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
          transition={reduceMotion ? { duration: 0 } : flow(3)}
          className="overflow-hidden"
        >
          <div ref={inner} className="px-6 pb-4">
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
      transition={flow(2)}
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
  if (!period || !entry.financials) return <p className="text-[13px] text-ink-3">No data for this period.</p>;
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
    <div className="w-0 min-w-full space-y-1.5 border-l-2 border-spruce/40 pl-3 text-left text-[13px] leading-5 text-ink-2">
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

function rowClass(row: Row, hovered: string | null, pad = "px-6") {
  const align = TWO_LINE.has(row.kind) ? "items-start pt-[8px]" : "items-center";
  const base = `${HEIGHT[row.kind]} flex ${align} border-b border-line ${pad} transition-colors duration-[var(--dur-1)]`;
  if (row.kind === "section") return `${base} bg-canvas`;
  const rule = row.kind === "metric" ? ledgerRule(row.key) : "";
  return `${base} ${rule} ${hovered === row.id ? "bg-subtle" : ""}`;
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
        className={`${HEADER_H} group relative flex cursor-pointer flex-col justify-between border-b border-line px-6 pt-4 pb-3`}
        onClick={onFocus}
        title={focused ? "Focused: drives valuation, news and narrative" : "Click to focus"}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* Shares a layoutId with the peer pill, so a clicked pill flies into this header. */}
            <div className="flex items-baseline gap-2">
              <motion.div layoutId={`company-${entry.id}`} className="w-fit font-mono text-[20px] leading-7 font-bold tracking-tight text-ink">
                {symbolOf(entry)}
              </motion.div>
              <SourceTag financials={entry.financials} />
            </div>
            <div className="truncate text-[13px] text-ink-3">
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
            className="-mr-2 grid size-8 shrink-0 place-items-center rounded-full text-[18px] text-ink-3 transition-colors duration-[var(--dur-1)] hover:bg-subtle hover:text-ink"
          >
            ×
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line-strong pt-2">
          <span className="truncate font-mono text-[12px] whitespace-nowrap text-ink-3" title={period ? `${periodLabel(period)} · period ended ${period.end}` : undefined}>
            {period ? `${periodLabel(period)} · ${period.end}` : loading ? "" : "no data"}
          </span>
          {flags > 0 && (
            <span className="shrink-0 rounded-full bg-mint px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-mint-ink" title="Material YoY variances in this period">
              {flags} flags
            </span>
          )}
        </div>
      </div>

      {entry.status === "error" ? (
        entry.unavailable ? (
          // Needs an API key the site doesn't have: a neutral button that explains, not a raw error.
          <div className="flex-1 px-6 py-4">
            <UnavailableButton subject={symbolOf(entry)} />
          </div>
        ) : (
          <div className="flex-1 px-6 py-4 text-[14px] text-loss">{entry.error}</div>
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
                className={`${HEIGHT.ratio} flex cursor-pointer items-center justify-end px-6`}
                onClick={() => !loading && accordion.toggle(row.key)}
                title={accordion.open.has(row.key) ? "Hide analysis" : "Show what this ratio means for this company"}
              >
                {loading ? (
                  <div className="h-3 w-20 animate-pulse rounded-xs bg-subtle" />
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
                row.kind !== "section" && <div className="h-3 w-20 animate-pulse rounded-xs bg-subtle" />
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

  // Columns slide in and out on the shared curve.
  const spring = flow(3);
  const enter = reduceMotion ? { opacity: 0 } : { opacity: 0, x: 48 };
  const exit = reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24 };

  return (
    // Label card + one card per company; fixed row heights keep every row aligned across the cards.
    // The strip scrolls sideways inside its own container on narrow screens.
    <div className="-m-1 overflow-x-auto p-1" onMouseLeave={() => setHovered(null)}>
      <div className="flex min-w-max items-stretch gap-4">
        {/* Label column */}
        <div className="panel sticky left-0 z-20 w-[148px] shrink-0 overflow-hidden sm:w-[268px]">
          <div className={`${HEADER_H} flex flex-col justify-between border-b border-line px-5 pt-4 pb-3`}>
            <span className="eyebrow">Period</span>
            <Segmented
              label="Period offset"
              role="group"
              size="sm"
              className="!gap-0 [&_.seg-item]:!px-2"
              value={String(offset)}
              onChange={(v) => setOffset(Number(v))}
              options={OFFSETS.map((o) => ({ key: String(o), label: o === 0 ? "Latest" : `−${o}${unit}` }))}
            />
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
                  className={`${HEIGHT.ratio} flex w-full items-center gap-2 px-5 text-left`}
                >
                  <Chevron open={accordion.open.has(row.key)} />
                  <span className="truncate text-[14px] text-ink">{row.label}</span>
                </button>
                <ExpandSlot rowKey={row.key} slot="label" accordion={accordion}>
                  <dl className="space-y-2 text-[13px] leading-5">
                    <div>
                      <dt className="eyebrow">Formula</dt>
                      <dd className="text-ink-2">{RATIO_LESSONS[row.key].formula}</dd>
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
              <div key={row.id} className={rowClass(row, hovered, "px-5")} onMouseEnter={() => onHover(row)}>
                {row.kind === "section" ? (
                  <span className="eyebrow !text-spruce">{row.title}</span>
                ) : (
                  <div className="min-w-0" title={"hint" in row ? row.hint : undefined}>
                    <div className="truncate text-[13px] leading-5 text-ink sm:text-[14px]">{row.label}</div>
                    {"hint" in row && <div className="truncate text-[11px] text-ink-3">{row.hint}</div>}
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
                className={`panel w-[230px] shrink-0 grow overflow-hidden xl:w-auto xl:max-w-[400px] xl:min-w-[210px] xl:basis-0 ${
                  entry.id === focusedId ? "!border-spruce shadow-2 ring-[3px] ring-mint" : "card-lift"
                }`}
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
                className="flex w-[190px] shrink-0 grow flex-col items-center justify-start gap-1.5 rounded-lg border-[1.5px] border-dashed border-control-border pt-12 text-ink-2 transition-colors duration-[var(--dur-2)] ease-[var(--ease-flow)] hover:bg-mint hover:text-mint-ink"
              >
                {/* Top-aligned (not centered in a column ~2,000px tall) so the prompt is visible without scrolling. */}
                <span className="mb-1 grid size-10 place-items-center rounded-full bg-spruce text-[22px] leading-none text-on-spruce">+</span>
                <span className="text-[14px] font-semibold">Compare a company</span>
                <span className="text-[13px] text-ink-3">
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
