"use client";

import { useMemo } from "react";

import { ChartRow, ProjectionChart, SeriesKey, useDarkMode } from "@/components/ProjectionChart";
import type { FinancialPeriod } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  Assumptions,
  Baseline,
  PROJECTION_YEARS,
  SLIDER_RANGES,
  TERMINAL_GROWTH_PCT,
  deriveBaseline,
  project,
} from "@/lib/valuation";
import { useAssumptions } from "@/lib/valuationAssumptions";

function Slider({
  id,
  label,
  value,
  onChange,
  range,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  range: { min: number; max: number; step: number };
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] text-ink">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-[13px] text-ink tabular-nums">
          {value > 0 && range.min < 0 ? "+" : ""}
          {value.toFixed(range.step < 0.5 ? 2 : 1)}%
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-zinc-900 dark:accent-zinc-100"
      />
      <div className="mt-0.5 flex justify-between text-[11px] text-ink-4">
        <span>{range.min}%</span>
        {hint && <span className="text-ink-3">{hint}</span>}
        <span>{range.max > 0 && range.min < 0 ? "+" : ""}{range.max}%</span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-l border-line py-0.5 pl-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-mono text-xl tracking-tight text-ink tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function buildChartData(history: FinancialPeriod[], baseline: Baseline, years: ReturnType<typeof project>["years"]): ChartRow[] {
  const actual: ChartRow[] = [...history]
    .filter((p) => p.fiscal_year != null && p.fiscal_year <= baseline.baseFiscalYear)
    .reverse()
    .map((p) => ({
      label: `FY${p.fiscal_year}`,
      earnings: p.line_items.net_income?.value ?? null,
      fcf: p.line_items.free_cash_flow?.value ?? null,
      projected: false,
    }));
  // Seed the projected series at the last actual point so dashed lines continue from history.
  const last = actual[actual.length - 1];
  if (last) {
    last.earningsProjected = last.earnings;
    last.fcfProjected = last.fcf;
  }
  const projected: ChartRow[] = years.map((y) => ({
    label: `FY${y.fiscalYear}E`,
    earningsProjected: y.earnings,
    fcfProjected: y.fcf,
    projected: true,
  }));
  return [...actual, ...projected];
}

export function ValuationPanel({
  companyId,
  annualPeriods,
  currency = "USD",
}: {
  companyId: string;
  annualPeriods: FinancialPeriod[];
  currency?: string;
}) {
  const formatUsd = (v: number | null | undefined) => formatMoney(v, currency);
  const baseline = useMemo(() => deriveBaseline(annualPeriods), [annualPeriods]);
  const dark = useDarkMode();
  // Shared with the side panel's Intrinsic Valuation Station, per company.
  const [assumptions, setShared] = useAssumptions(companyId, baseline?.defaults ?? null);

  const valuation = useMemo(() => (baseline && assumptions ? project(baseline, assumptions) : null), [baseline, assumptions]);
  const chartData = useMemo(
    () => (baseline && valuation ? buildChartData(annualPeriods, baseline, valuation.years) : []),
    [annualPeriods, baseline, valuation],
  );

  if (!baseline || !assumptions || !valuation) {
    return <p className="text-ink-3">Not enough annual revenue history to build a projection.</p>;
  }

  const set = (key: keyof Assumptions) => (v: number) => setShared({ ...assumptions, [key]: v });
  const final = valuation.years[valuation.years.length - 1];
  const terminalShare = valuation.enterpriseValue > 0 ? (valuation.pvTerminalValue / valuation.enterpriseValue) * 100 : null;
  const isDefault = (Object.keys(assumptions) as (keyof Assumptions)[]).every((k) => assumptions[k] === baseline.defaults[k]);

  return (
    <div className="panel">
      <div className="grid gap-6 p-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <h4 className="eyebrow">Assumptions</h4>
            <button
              type="button"
              onClick={() => setShared(baseline.defaults)}
              disabled={isDefault}
              className="text-xs link disabled:text-ink-4 disabled:no-underline"
            >
              Reset
            </button>
          </div>
          <Slider
            id="growth"
            label="Revenue Growth Rate"
            value={assumptions.revenueGrowthPct}
            onChange={set("revenueGrowthPct")}
            range={SLIDER_RANGES.revenueGrowthPct}
            hint={baseline.historicalRevenueCagrPct != null ? `3-yr CAGR ${baseline.historicalRevenueCagrPct.toFixed(1)}%` : undefined}
          />
          <Slider
            id="margin"
            label="Target Operating Margin"
            value={assumptions.operatingMarginPct}
            onChange={set("operatingMarginPct")}
            range={SLIDER_RANGES.operatingMarginPct}
            hint={baseline.latestOperatingMarginPct != null ? `FY${baseline.baseFiscalYear} ${baseline.latestOperatingMarginPct.toFixed(1)}%` : undefined}
          />
          <Slider
            id="wacc"
            label="Discount Rate / WACC"
            value={assumptions.waccPct}
            onChange={set("waccPct")}
            range={SLIDER_RANGES.waccPct}
          />
          <dl className="space-y-1 border-t border-line pt-4 text-[11px] text-ink-3">
            <div className="flex justify-between">
              <dt>Earnings ÷ operating income</dt>
              <dd className="font-mono">{(baseline.earningsConversion * 100).toFixed(0)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt>FCF ÷ earnings</dt>
              <dd className="font-mono">{(baseline.fcfConversion * 100).toFixed(0)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt>Terminal growth</dt>
              <dd className="font-mono">{TERMINAL_GROWTH_PCT}%</dd>
            </div>
            <p className="pt-1 text-[11px] leading-snug text-ink-4">Conversion rates are this company&apos;s 3-year historical averages.</p>
          </dl>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Enterprise value (DCF)" value={formatUsd(valuation.enterpriseValue)} />
            <Stat label="PV of 5-yr FCF" value={formatUsd(valuation.pvExplicitFcf)} />
            <Stat
              label="PV of terminal value"
              value={formatUsd(valuation.pvTerminalValue)}
              sub={terminalShare != null ? `${terminalShare.toFixed(0)}% of EV` : undefined}
            />
            <Stat label={`FY${final.fiscalYear}E earnings`} value={formatUsd(final.earnings)} sub={`FCF ${formatUsd(final.fcf)}`} />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-[13px] text-ink">Earnings &amp; free cash flow — actual vs. {PROJECTION_YEARS}-year projection</h4>
              <SeriesKey dark={dark} />
            </div>
            <ProjectionChart data={chartData} currency={currency} />
          </div>
          {baseline.notes.length > 0 && (
            <ul className="space-y-0.5 text-xs text-ink-3">
              {baseline.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <details className="border-t border-line px-5 py-3 text-[13px]">
        <summary className="eyebrow cursor-pointer">Projection table</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-right font-mono text-xs tabular-nums">
            <thead className="text-ink-3">
              <tr>
                <th className="py-1 text-left font-sans font-medium">Fiscal year</th>
                <th className="font-sans font-medium">Revenue</th>
                <th className="font-sans font-medium">Operating income</th>
                <th className="font-sans font-medium">Earnings</th>
                <th className="font-sans font-medium">Free cash flow</th>
                <th className="font-sans font-medium">PV of FCF</th>
              </tr>
            </thead>
            <tbody>
              {valuation.years.map((y) => (
                <tr key={y.fiscalYear} className="border-t border-line">
                  <td className="py-1 text-left font-sans">FY{y.fiscalYear}E</td>
                  <td>{formatUsd(y.revenue)}</td>
                  <td>{formatUsd(y.operatingIncome)}</td>
                  <td>{formatUsd(y.earnings)}</td>
                  <td>{formatUsd(y.fcf)}</td>
                  <td>{formatUsd(y.pvFcf)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
