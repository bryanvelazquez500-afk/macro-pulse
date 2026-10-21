"use client";

import { useMemo } from "react";

import { ChartRow, ProjectionChart, SeriesKey, useDarkMode } from "@/components/ProjectionChart";
import { FinancialPeriod, fetchValuationInputs } from "@/lib/api";
import { currencySymbol, formatMoney } from "@/lib/format";
import { capm } from "@/lib/intrinsic";
import { useFetch } from "@/lib/useFetch";
import {
  Assumptions,
  Baseline,
  FADE_YEARS,
  PROJECTION_YEARS,
  SLIDER_RANGES,
  TERMINAL_GROWTH_PCT,
  TERMINAL_SHARE_WARNING,
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
        className="w-full cursor-pointer accent-spruce dark:accent-spruce"
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
  // CAPM inputs (live 10Y Treasury, sector beta, ERP) and the share price — the panel is keyed by company.
  const inputs = useFetch((signal) => fetchValuationInputs(companyId, signal));
  const loaded = inputs.status === "success" ? inputs.data : null;
  const ke = loaded ? capm(loaded.risk_free_rate.value, loaded.beta.value, loaded.equity_risk_premium.value) : null;
  const baseline = useMemo(
    () => (inputs.status === "loading" ? null : deriveBaseline(annualPeriods, ke)),
    [annualPeriods, ke, inputs.status],
  );
  const dark = useDarkMode();
  // Shared with the Intrinsic Valuation Station, per company.
  const [assumptions, setShared] = useAssumptions(companyId, baseline?.defaults ?? null);

  const valuation = useMemo(() => (baseline && assumptions ? project(baseline, assumptions) : null), [baseline, assumptions]);
  const chartData = useMemo(
    () => (baseline && valuation ? buildChartData(annualPeriods, baseline, valuation.years) : []),
    [annualPeriods, baseline, valuation],
  );

  if (inputs.status === "loading") return <p className="text-ink-3">Loading CAPM inputs…</p>;
  if (!baseline || !assumptions || !valuation) {
    return <p className="text-ink-3">Not enough annual revenue history to build a projection.</p>;
  }
  const price = loaded?.price && loaded.price.comparable ? loaded.price.price : null;
  const mos = price != null && valuation.perShare != null ? (valuation.perShare - price) / valuation.perShare : null;

  const set = (key: keyof Assumptions) => (v: number) => setShared({ ...assumptions, [key]: v });
  const terminalShare = valuation.terminalShare * 100;
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
            hint={
              baseline.pooledOperatingMarginPct != null
                ? `3-yr avg ${baseline.pooledOperatingMarginPct.toFixed(1)}%`
                : baseline.latestOperatingMarginPct != null
                  ? `FY${baseline.baseFiscalYear} ${baseline.latestOperatingMarginPct.toFixed(1)}%`
                  : undefined
            }
          />
          <Slider
            id="ke"
            label="Cost of Equity (CAPM)"
            value={assumptions.costOfEquityPct}
            onChange={set("costOfEquityPct")}
            range={SLIDER_RANGES.costOfEquityPct}
            hint={
              loaded && ke != null
                ? `${(loaded.risk_free_rate.value * 100).toFixed(2)}% + ${loaded.beta.value.toFixed(2)}β × ${(loaded.equity_risk_premium.value * 100).toFixed(2)}%`
                : undefined
            }
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
            <p className="pt-1 text-[11px] leading-snug text-ink-4">
              Conversion rates are this company&apos;s 3-year GAAP averages. Free cash flow (operating cash flow − capex) is after interest, so
              it&apos;s discounted at the cost of equity and gives equity value. Growth holds for {PROJECTION_YEARS} years, then fades to{" "}
              {TERMINAL_GROWTH_PCT}% over the next {FADE_YEARS}.
            </p>
          </dl>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat
              label="Equity value (DCF)"
              value={formatUsd(valuation.equityValue)}
              sub={valuation.enterpriseValue != null ? `EV ${formatUsd(valuation.enterpriseValue)} (+ debt − cash)` : undefined}
            />
            <Stat
              label="Value per share"
              value={valuation.perShare != null ? `${currencySymbol(currency)}${valuation.perShare.toFixed(2)}` : "—"}
              sub={
                mos != null && price != null && valuation.perShare != null
                  ? mos >= 0
                    ? `▲ ${(mos * 100).toFixed(0)}% margin of safety vs price ${currencySymbol(currency)}${price.toFixed(2)}`
                    : `▼ price ${currencySymbol(currency)}${price.toFixed(2)} is ${(price / valuation.perShare).toFixed(1)}× this value`
                  : (loaded?.price_note ?? "No comparable share price")
              }
            />
            <Stat label={`PV of ${PROJECTION_YEARS + FADE_YEARS}-yr FCF`} value={formatUsd(valuation.pvExplicitFcf)} />
            <Stat
              label="PV of terminal value"
              value={formatUsd(valuation.pvTerminalValue)}
              sub={`${terminalShare.toFixed(0)}% of equity value`}
            />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-[13px] text-ink">
                Earnings &amp; free cash flow — actual vs. {PROJECTION_YEARS + FADE_YEARS}-year projection
              </h4>
              <SeriesKey dark={dark} />
            </div>
            <ProjectionChart data={chartData} currency={currency} />
          </div>
          {valuation.terminalShare > TERMINAL_SHARE_WARNING && (
            <p role="alert" className="rounded-md bg-caution-bg px-3 py-2 text-[12px] text-caution ring-1 ring-caution/30 ring-inset">
              ⚠ Terminal value is {terminalShare.toFixed(0)}% of the total (over {TERMINAL_SHARE_WARNING * 100}%): most of this value sits beyond
              year {PROJECTION_YEARS + FADE_YEARS}, so check whether the near-term growth and margin are realistic.
            </p>
          )}
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
                <th className="font-sans font-medium">Growth</th>
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
                  <td>{(y.growth * 100).toFixed(1)}%</td>
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
