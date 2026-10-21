"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ReactNode, useMemo, useState } from "react";

import { FinancialPeriod, MacroFactors, Rate, ValuationInputs, fetchValuationInputs, syncMacroFactors } from "@/lib/api";
import { currencySymbol } from "@/lib/format";
import {
  FALLBACK_RISK_FREE_RATE,
  ModelResult,
  capm,
  defaultDividendGrowth,
  dividendGrowthCeiling,
  GRAHAM_GROWTH_CAP_PCT,
  gordonDdm,
  grahamGrowthPct,
  grahamValue,
  marginOfSafety,
  statementInputs,
} from "@/lib/intrinsic";
import { useFetch } from "@/lib/useFetch";

const pct = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`;

function money(v: number, currency: string) {
  return `${currencySymbol(currency)}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------- margin-of-safety badge

/** Emerald when the price sits below intrinsic value (positive margin of safety), crimson above it. */
function SafetyBadge({ mos, reason }: { mos: number | null; reason?: string }) {
  // Past −100% (price over twice the value) a percentage stops being readable: show price ÷ value instead.
  const reduceMotion = useReducedMotion();
  if (mos == null) {
    return (
      <span className="rounded-full px-2 py-0.5 font-mono text-[10.5px] text-ink-3 ring-1 ring-line-strong ring-inset" title={reason}>
        n/a
      </span>
    );
  }
  const safe = mos > 0;
  const label = mos >= -1 ? `${mos > 0 ? "+" : "−"}${Math.abs(mos * 100).toFixed(0)}%` : `${(1 - mos).toFixed(1)}× value`;
  const pctLabel = `${mos > 0 ? "+" : "−"}${Math.abs(mos * 100).toFixed(0)}%`;
  return (
    <motion.span
      layout
      // Re-keyed on the sign so crossing zero (sliders, a rate sync) visibly flips the badge.
      key={safe ? "safe" : "unsafe"}
      initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 24 }}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums ${
        safe
          ? "bg-gain text-on-spruce"
          : "bg-loss text-on-drop-4"
      }`}
      title={`Margin of safety: (intrinsic − price) ÷ intrinsic = ${pctLabel}${mos < -1 ? ` — price is ${(1 - mos).toFixed(1)}× intrinsic value` : ""}`}
    >
      <span aria-hidden>{safe ? "▲" : "▼"}</span>
      <span className="sr-only">{safe ? "Margin of safety" : mos >= -1 ? "Overvalued by" : "Price is"}</span>
      <motion.span key={label} initial={reduceMotion ? false : { opacity: 0.4 }} animate={{ opacity: 1 }}>
        {label}
      </motion.span>
    </motion.span>
  );
}

// ---------------------------------------------------------------- pieces

function Inline({ label, value, sub, flash }: { label: string; value: string; sub?: ReactNode; flash?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <motion.div
        key={value}
        initial={flash ? { backgroundColor: "rgba(16,185,129,0.28)" } : false}
        animate={{ backgroundColor: "rgba(16,185,129,0)" }}
        transition={{ duration: 1.4 }}
        className="-mx-1 mt-0.5 rounded px-1 font-mono text-[15px] font-semibold text-ink tabular-nums"
      >
        {value}
      </motion.div>
      {sub && <div className="truncate text-[10.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function TargetRow({
  name,
  formula,
  result,
  price,
  currency,
  extra,
}: {
  name: string;
  formula: string;
  result: ModelResult;
  price: { value: number; comparable: boolean; note: string | null } | null;
  currency: string;
  extra?: ReactNode;
}) {
  const mos = result.ok && price?.comparable ? marginOfSafety(result.value, price.value) : null;
  const reason = !result.ok ? undefined : !price ? "No share price available" : !price.comparable ? (price.note ?? "Price not comparable") : undefined;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{name}</div>
          <div className="truncate font-mono text-[10.5px] text-ink-4" title={formula}>
            {formula}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`font-mono text-[15px] font-semibold tabular-nums ${result.ok ? "text-ink" : "text-ink-4"}`}>
            {result.ok ? money(result.value, currency) : "—"}
          </span>
          {result.ok && <SafetyBadge mos={mos} reason={reason} />}
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-ink-3">{result.ok ? result.detail : result.reason}</p>
      {result.ok && extra && <div className="mt-1 text-[11px] leading-snug text-ink-3">{extra}</div>}
    </li>
  );
}

// ---------------------------------------------------------------- station

type SyncState = { status: "idle" } | { status: "syncing" } | { status: "error"; message: string } | { status: "done"; previous: number };

export function IntrinsicValuationStation({
  companyId,
  symbol,
  annualPeriods,
  currency,
}: {
  companyId: string;
  symbol: string;
  annualPeriods: FinancialPeriod[];
  currency: string;
}) {
  const inputs = useFetch((signal) => fetchValuationInputs(companyId, signal));
  const statements = useMemo(() => statementInputs(annualPeriods), [annualPeriods]);

  // Overrides from "Sync Live Market Factors" replace the cached rate immediately.
  const [synced, setSynced] = useState<{ riskFree: Rate; erp: Rate; aaa: Rate | null } | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [dividendGrowth, setDividendGrowth] = useState<number | null>(null);

  const loaded: ValuationInputs | null = inputs.status === "success" ? inputs.data : null;
  const riskFree = synced?.riskFree ?? loaded?.risk_free_rate ?? null;
  const rf = riskFree?.value ?? FALLBACK_RISK_FREE_RATE;
  const erp = synced?.erp.value ?? loaded?.equity_risk_premium.value ?? null;
  const beta = loaded?.beta.value ?? null;
  const ke = erp != null && beta != null ? capm(rf, beta, erp) : null;

  async function onSync() {
    setSync({ status: "syncing" });
    try {
      const f: MacroFactors = await syncMacroFactors();
      setSync({ status: "done", previous: rf });
      setSynced({ riskFree: f.risk_free_rate, erp: f.equity_risk_premium, aaa: f.aaa_yield ?? null });
    } catch (e) {
      setSync({ status: "error", message: e instanceof Error ? e.message : "Sync failed" });
    }
  }

  // Graham: Y is the Aaa corporate yield (the Treasury only if Aaa is unavailable), g the company's own EPS growth.
  const aaa = synced?.aaa ?? loaded?.aaa_yield ?? null;
  const grahamY = aaa?.value ?? rf;
  const grahamG = grahamGrowthPct(statements);
  const gd = dividendGrowth ?? (ke != null ? defaultDividendGrowth(statements, ke, rf) : 0);
  const gdCeiling = ke != null ? dividendGrowthCeiling(rf, ke) : null;
  const pending: ModelResult = { ok: false, reason: inputs.status === "error" ? inputs.error : "Loading market inputs…" };

  const ddm = ke != null ? gordonDdm(statements, gd, ke) : pending;
  const graham = inputs.status === "loading" ? pending : grahamValue(statements, grahamG, grahamY);
  const quote = loaded?.price ?? null;
  const price = quote ? { value: quote.price, comparable: quote.comparable, note: loaded?.price_note ?? null } : null;

  return (
    <section className="panel overflow-hidden" aria-labelledby="ivs-title">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id="ivs-title" className="eyebrow">
          Intrinsic Valuation Station
        </h2>
        <motion.button
          type="button"
          onClick={onSync}
          disabled={sync.status === "syncing"}
          whileTap={{ scale: 0.96 }}
          className="inline-flex items-center gap-1.5 rounded-md bg-inverse px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap text-on-inverse transition-opacity hover:opacity-85 disabled:opacity-60"
          title="Fetch the latest 10-year Treasury yield (U.S. Treasury / FRED) and overwrite the risk-free rate"
        >
          <motion.span
            aria-hidden
            animate={sync.status === "syncing" ? { rotate: [0, -12, 12, 0] } : { rotate: 0 }}
            transition={sync.status === "syncing" ? { repeat: Infinity, duration: 0.5 } : undefined}
          >
            ⚡
          </motion.span>
          {sync.status === "syncing" ? "Syncing…" : "Sync Live Market Factors"}
        </motion.button>
      </header>

      <div className="space-y-4 p-4">
        {/* Current price — the anchor the target prices are measured against. */}
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="eyebrow">{symbol} · current price</div>
            <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight text-ink tabular-nums">
              {quote ? money(quote.price, quote.currency) : "—"}
            </div>
          </div>
          <div className="text-right text-[10.5px] text-ink-3">
            {quote ? quote.source : inputs.status === "loading" ? "Loading…" : "No price"}
            {quote && !quote.comparable && <div className="max-w-40 text-ink-4">{loaded?.price_note}</div>}
          </div>
        </div>

        {/* CAPM */}
        <div className="rounded-lg bg-subtle p-3">
          <div className="grid grid-cols-3 gap-2">
            <Inline
              label="Risk-free"
              value={pct(rf)}
              flash={sync.status === "done"}
              sub={riskFree ? `10Y UST · ${riskFree.as_of}` : "Fallback 4.15%"}
            />
            <Inline label="Beta" value={beta != null ? beta.toFixed(2) : "—"} sub={loaded?.beta.group_label} />
            <Inline label="ERP" value={erp != null ? pct(erp) : "—"} sub="Damodaran (US)" />
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-line pt-2.5">
            <span className="text-[12px] text-ink-2">
              CAPM cost of equity <span className="text-ink-4">= r_f + β × ERP</span>
            </span>
            <span className="font-mono text-[17px] font-semibold text-ink tabular-nums">{ke != null ? pct(ke) : "—"}</span>
          </div>
          <p className="mt-0.5 text-[10.5px] text-ink-3">Discount rate for the DDM below. DCF values live in the DCF Calculator beside it.</p>
          <AnimatePresence>
            {sync.status === "done" && riskFree && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-1.5 text-[10.5px] text-gain dark:text-gain"
                role="status"
              >
                {Math.abs(sync.previous - riskFree.value) < 1e-9 ? "Up to date" : `Synced: ${pct(sync.previous)} → ${pct(riskFree.value)}`} —{" "}
                {riskFree.source}, {riskFree.as_of}
              </motion.p>
            )}
            {sync.status === "error" && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1.5 text-[10.5px] text-loss dark:text-loss" role="alert">
                {sync.message}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Target prices vs. current price */}
        <div>
          <div className="flex items-baseline justify-between">
            <h3 className="eyebrow">Intrinsic value per share</h3>
            <span className="text-[10.5px] text-ink-4">margin of safety</span>
          </div>
          <ul className="divide-y divide-line">
            <TargetRow name="Gordon Growth DDM" formula="D₀(1+g)/(kₑ − g)" result={ddm} price={price} currency={currency} />
            <TargetRow
              name="Benjamin Graham"
              formula="EPS × (8.5 + 2g) × 4.4 / Y (Aaa yield)"
              result={graham}
              price={price}
              currency={currency}
              extra={
                <span className="text-ink-4">
                  g = {statements.epsCagr != null ? `${statements.epsCagrYears}-yr EPS growth ${(statements.epsCagr * 100).toFixed(1)}%` : "no EPS history"}
                  {statements.epsCagr != null && statements.epsCagr * 100 > GRAHAM_GROWTH_CAP_PCT && `, held to ${GRAHAM_GROWTH_CAP_PCT}%`}
                  {(statements.epsCagr == null || statements.epsCagr < 0) && ", taken as 0%"} · Y ={" "}
                  {aaa ? `Moody's Aaa ${(aaa.value * 100).toFixed(2)}% (${aaa.as_of})` : `10Y Treasury ${(rf * 100).toFixed(2)}% (Aaa yield unavailable)`}
                </span>
              }
            />
          </ul>
        </div>

        {/* Inputs that drive the models */}
        <div className="space-y-2 border-t border-line pt-3 text-[11px] text-ink-3">
          <div className="flex justify-between gap-2">
            <span>Graham g · Y</span>
            <span className="font-mono text-ink-2">
              {grahamG.toFixed(1)}% · {(grahamY * 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>FY{statements.fiscalYear ?? "—"} diluted EPS · shares (SEC)</span>
            <span className="font-mono text-ink-2">
              {statements.eps != null ? statements.eps.toFixed(2) : "—"} · {statements.shares != null ? `${(statements.shares / 1e9).toFixed(3)}B` : "—"}
            </span>
          </div>
          {statements.dividendPerShare != null && statements.dividendPerShare > 0 && (
            <label className="block">
              <span className="flex justify-between gap-2">
                <span>Dividend growth (DDM)</span>
                <span className="font-mono text-ink-2">{(gd * 100).toFixed(1)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0.005, Math.floor(((ke ?? 0.1) - 0.005) * 200) / 200)}
                step={0.0025}
                value={gd}
                onChange={(e) => setDividendGrowth(Number(e.target.value))}
                className="mt-1 w-full cursor-pointer accent-spruce dark:accent-spruce"
                aria-label="Dividend growth rate"
              />
              <span className={gdCeiling != null && gd > gdCeiling + 1e-9 ? "text-caution dark:text-caution" : "text-ink-4"}>
                {gdCeiling != null && gd > gdCeiling + 1e-9
                  ? `Above the ${(gdCeiling * 100).toFixed(1)}% sustainable ceiling — a forever growth rate this high inflates the value.`
                  : `Starts at the company's ${statements.dividendCagr != null ? `${(statements.dividendCagr * 100).toFixed(1)}%` : "—"} dividend-per-share growth, capped at ${gdCeiling != null ? (gdCeiling * 100).toFixed(1) : "—"}% (the lower of r_f and kₑ − 2pp).`}
              </span>
            </label>
          )}
          <p className="leading-snug text-ink-4">
            Values are per diluted share in {currency}. Graham uses the risk-free rate where his original formula used the AAA corporate
            yield.
          </p>
        </div>
      </div>
    </section>
  );
}
