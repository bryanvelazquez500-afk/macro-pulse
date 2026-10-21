"use client";

/**
 * Interactive two-stage DCF calculator (GuruFocus-style), fed by the live data pipelines.
 *
 * Loading a ticker fetches its inputs once (/api/companies/{id}/dcf-inputs: price, TTM EPS / FCF /
 * dividend per share, tangible book, historical growth, 10-year Treasury) and applies the defaults.
 * Every control then recalculates on the client (lib/dcf.ts). A background price poll replaces only P,
 * so the user's adjustments survive live updates.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { UnavailableButton } from "@/components/UnavailableButton";
import { Segmented } from "@/components/Segmented";
import { DcfBasisKey, DcfInputs, fetchDcfInputs, fetchLiveQuote, needsApiKey } from "@/lib/api";
import {
  DEFAULT_GROWTH_YEARS,
  DEFAULT_TERMINAL_GROWTH,
  DEFAULT_TERMINAL_YEARS,
  defaultDiscountRate,
  defaultGrowthRate,
  marginOfSafety,
  projection,
  reverseDcfGrowth,
  twoStage,
} from "@/lib/dcf";
import { currencySymbol } from "@/lib/format";
import { normalizeTicker } from "@/lib/portfolioStore";
import { useSavedDcfs } from "@/lib/savedDcfStore";
import { TickerSuggestions } from "@/lib/useTickerSuggestions";

const PRICE_POLL_MS = 60_000;
// "EPS without NRI" is a GuruFocus adjustment the filings don't carry: GAAP diluted EPS is used (see Data sources & gaps).
const BASIS_LABELS: Record<DcfBasisKey, string> = { eps: "EPS", fcf: "FCF", dividend: "Adj. Dividend" };

interface Params {
  basis: DcfBasisKey;
  e0: number | null;
  d: number; // percent
  g1: number; // percent
  n: number;
  g2: number; // percent
  m: number;
  addTbv: boolean;
}

type Load = { status: "idle" } | { status: "loading"; symbol: string } | { status: "error"; symbol: string; error: unknown } | { status: "ready"; inputs: DcfInputs };

const round2 = (v: number) => Math.round(v * 100) / 100;
const round1 = (v: number) => Math.round(v * 10) / 10;

function basisOf(inputs: DcfInputs, key: DcfBasisKey) {
  return inputs.bases.find((b) => b.key === key) ?? null;
}

/** The defaults, applied when a ticker loads or "Reset defaults" is clicked. */
function defaults(inputs: DcfInputs, basis: DcfBasisKey): Params {
  const b = basisOf(inputs, basis);
  return {
    basis,
    e0: b?.value != null ? round2(b.value) : null,
    d: round2(defaultDiscountRate(inputs.t10) * 100),
    g1: round1(defaultGrowthRate(b?.h10 ?? null) * 100),
    n: DEFAULT_GROWTH_YEARS,
    g2: DEFAULT_TERMINAL_GROWTH * 100,
    m: DEFAULT_TERMINAL_YEARS,
    addTbv: false,
  };
}

function money(v: number, currency: string) {
  const sign = v < 0 ? "−" : "";
  return `${sign}${currencySymbol(currency)}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const pct = (v: number, digits = 2) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;

// ---------------------------------------------------------------- controls

function Stepper({
  label,
  value,
  onChange,
  suffix,
  min = -100,
  max = 1000,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  hint?: ReactNode;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const btn =
    "grid size-8 shrink-0 place-items-center rounded-xs border border-control-border bg-panel text-[15px] font-semibold text-ink-2 transition-colors duration-[var(--dur-1)] hover:bg-subtle hover:text-ink active:translate-y-px";
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className="flex items-center gap-0.5">
        <button type="button" className={btn} onClick={() => onChange(round2(clamp(value - 1)))} aria-label={`Decrease ${label}`}>
          −
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (Number.isFinite(v)) onChange(clamp(v));
            }}
            aria-label={label}
            className="field !h-8 w-full !rounded-xs !px-2 !py-0 pr-5 text-right !text-[14px] font-semibold tabular-nums"
          />
          {suffix && <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[12px] text-ink-3">{suffix}</span>}
        </div>
        <button type="button" className={btn} onClick={() => onChange(round2(clamp(value + 1)))} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
      {hint && <div className="mt-0.5 truncate text-[12px] text-ink-3">{hint}</div>}
    </div>
  );
}

function Stars({ value }: { value: number | null }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={value == null ? "Predictability not available" : `Predictability ${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden className={value != null && i <= Math.round(value) ? "text-caution" : "text-line-strong"}>
          ★
        </span>
      ))}
    </span>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex gap-1.5 rounded-sm bg-caution-bg px-3 py-2 text-[13px] leading-5 text-caution">
      <span aria-hidden>⚠</span>
      <span>{children}</span>
    </p>
  );
}

/** Price marker vs. fair-value marker on one scale. */
function Gauge({ price, fairValue, currency }: { price: number; fairValue: number; currency: string }) {
  const reduceMotion = useReducedMotion();
  const top = Math.max(price, fairValue, 0) * 1.25 || 1;
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / top) * 100))}%`;
  const under = fairValue >= price;
  const [lo, hi] = under ? [price, fairValue] : [fairValue, price];
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 220, damping: 28 };
  return (
    <div className="pt-5 pb-6" aria-hidden>
      <div className="relative h-2 rounded-full bg-subtle">
        <motion.div
          className={`absolute inset-y-0 rounded-full ${under ? "bg-gain" : "bg-loss"}`}
          animate={{ left: at(Math.max(lo, 0)), width: `calc(${at(hi)} - ${at(Math.max(lo, 0))})` }}
          transition={spring}
        />
        <motion.div className="absolute -top-5 -translate-x-1/2 text-center" animate={{ left: at(price) }} transition={spring}>
          <div className="text-[12px] whitespace-nowrap text-ink-2">P {money(price, currency)}</div>
          <div className="mx-auto mt-0.5 h-5 w-0.5 rounded bg-ink" />
        </motion.div>
        <motion.div className="absolute top-[-2px] -translate-x-1/2 text-center" animate={{ left: at(Math.max(fairValue, 0)) }} transition={spring}>
          <div className="mx-auto h-3 w-3 rotate-45 rounded-[2px] bg-spruce" />
          <div className="mt-1 text-[12px] whitespace-nowrap text-spruce">FV {money(fairValue, currency)}</div>
        </motion.div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- calculator

export function DcfCalculator({ symbol }: { symbol: string | null }) {
  const [query, setQuery] = useState(symbol ?? "");
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [params, setParams] = useState<Params | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const { saved, save, remove } = useSavedDcfs();

  const loadTicker = useCallback(async (raw: string) => {
    const ticker = normalizeTicker(raw);
    if (!ticker) {
      setLoad({ status: "error", symbol: raw, error: new Error("Enter a valid ticker, e.g. AAPL, ASML.AS or 7203.T") });
      return;
    }
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setQuery(ticker);
    setLoad({ status: "loading", symbol: ticker });
    try {
      const inputs = await fetchDcfInputs(ticker, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setLoad({ status: "ready", inputs });
      setPrice(inputs.price);
      setParams(defaults(inputs, "eps"));
    } catch (error) {
      if (!ctrl.signal.aborted) setLoad({ status: "error", symbol: ticker, error });
    }
  }, []);

  // Follow the focused company: a new focus loads into the calculator (a typed ticker stays until focus moves).
  useEffect(() => {
    if (!symbol) return;
    // Deferred a tick: React's dev double-mount cancels the first timer instead of a request in flight.
    const timer = setTimeout(() => void loadTicker(symbol), 0);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
  }, [symbol, loadTicker]);

  const inputs = load.status === "ready" ? load.inputs : null;

  // Live price: replaces only P (same currency), never the user's adjustments.
  useEffect(() => {
    if (!inputs) return;
    const ctrl = new AbortController();
    const id = setInterval(() => {
      fetchLiveQuote(inputs.symbol, ctrl.signal).then(
        (q) => {
          if (q.currency === inputs.currency) setPrice(q.price);
        },
        () => {},
      );
    }, PRICE_POLL_MS);
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [inputs]);

  const set = <K extends keyof Params>(key: K, value: Params[K]) => setParams((p) => (p ? { ...p, [key]: value } : p));

  function switchBasis(basis: DcfBasisKey) {
    if (!inputs || !params) return;
    const b = basisOf(inputs, basis);
    setParams({ ...params, basis, e0: b?.value != null ? round2(b.value) : null, g1: round1(defaultGrowthRate(b?.h10 ?? null) * 100) });
  }

  const model = useMemo(() => {
    if (!inputs || !params || params.e0 == null) return null;
    const p = {
      e0: params.e0,
      d: params.d / 100,
      g1: params.g1 / 100,
      n: Math.max(0, Math.round(params.n)),
      g2: params.g2 / 100,
      m: Math.max(0, Math.round(params.m)),
      tbv: inputs.tbv ?? 0,
      addTbv: params.addTbv && inputs.tbv != null,
    };
    const result = twoStage(p);
    const comparable = price != null && inputs.price_comparable;
    return {
      p,
      result,
      mos: comparable ? marginOfSafety(result.fairValue, price) : null,
      implied: comparable ? reverseDcfGrowth(p, price) : null,
      rows: projection(p),
    };
  }, [inputs, params, price]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void loadTicker(query);
  }

  const basis = inputs && params ? basisOf(inputs, params.basis) : null;
  const cur = inputs?.currency ?? "USD";

  return (
    <section className="panel overflow-hidden" aria-labelledby="dcf-title">
      <header className="border-b border-line px-6 pt-5 pb-4 max-sm:px-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="dcf-title" className="type-card text-ink">
            DCF Calculator
          </h2>
          <span className="text-[12px] text-ink-3">two-stage · discounted earnings</span>
        </div>
        <form onSubmit={onSubmit} className="mt-2.5 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="Ticker (AAPL, ASML.AS…)"
            aria-label="Ticker"
            list="dcf-ticker-suggestions"
            className="field field-pill min-w-0 flex-1 !py-2 font-mono uppercase placeholder:font-sans placeholder:normal-case"
          />
          <TickerSuggestions id="dcf-ticker-suggestions" query={query} skip={query.trim().toUpperCase() === (symbol ?? "").toUpperCase()} />
          <button
            type="submit"
            disabled={load.status === "loading"}
            className="btn-primary btn-sm"
          >
            {load.status === "loading" ? "Loading…" : "Load"}
          </button>
        </form>
      </header>

      <div className="space-y-5 p-6 max-sm:p-4">
        {load.status === "idle" && <p className="text-[13px] text-ink-3">Enter a ticker to value it.</p>}
        {load.status === "loading" && (
          <div className="space-y-2" aria-busy="true">
            <div className="h-4 w-2/3 animate-pulse rounded bg-subtle" />
            <div className="h-16 animate-pulse rounded bg-subtle" />
          </div>
        )}
        {load.status === "error" &&
          (needsApiKey(load.error) ? (
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] text-ink-2">{load.symbol}</span>
              <UnavailableButton subject={load.symbol} />
            </div>
          ) : (
            <p role="alert" className="rounded-sm bg-loss-bg px-3 py-2 text-[13px] text-loss">
              Couldn&apos;t load {load.symbol}: {load.error instanceof Error ? load.error.message : "request failed"}
            </p>
          ))}

        {inputs && params && (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-semibold text-ink">{inputs.name}</div>
                <div className="font-mono text-[12px] text-spruce">{inputs.symbol}</div>
              </div>
              <div className="text-right">
                <div className="eyebrow">Price (P)</div>
                <motion.div key={price ?? "none"} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="text-[15px] font-semibold text-ink tabular-nums">
                  {price != null ? money(price, cur) : "—"}
                </motion.div>
              </div>
            </div>

            {/* Basis */}
            <div>
              <div className="eyebrow mb-1">Basis (E0)</div>
              <Segmented
                label="Valuation basis"
                value={params.basis}
                onChange={(k) => switchBasis(k)}
                className="grid w-full grid-cols-3 [&_.seg-item]:text-center"
                options={(Object.keys(BASIS_LABELS) as DcfBasisKey[]).map((k) => ({ key: k, label: BASIS_LABELS[k] }))}
              />
              <label className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[13px] text-ink-3">
                  E0 <span className="text-ink-3">· {basis?.label}</span>
                </span>
                <input
                  type="number"
                  step="any"
                  value={params.e0 ?? ""}
                  placeholder="n/a"
                  onChange={(e) => set("e0", Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null)}
                  aria-label="Base per-share value (E0)"
                  className="field !h-8 w-32 !rounded-xs !px-2 !py-0 text-right !text-[14px] font-semibold tabular-nums"
                />
              </label>
              <div className="mt-0.5 text-right text-[12px] text-ink-3">{basis?.period ?? "No data in the filings"}</div>
            </div>

            {/* Discount rate */}
            <Stepper
              label="Discount rate (d)"
              value={params.d}
              onChange={(v) => set("d", v)}
              suffix="%"
              hint={`Default ⌈${inputs.t10.toFixed(2)}% 10Y Treasury⌉ + 6%`}
            />

            {/* Stages */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-3 rounded-md border border-line bg-canvas p-4">
                <div className="text-[13px] font-semibold text-ink">Growth stage</div>
                <Stepper label="Years (n)" value={params.n} onChange={(v) => set("n", Math.round(v))} min={0} max={50} />
                <Stepper
                  label="Growth (g1)"
                  value={params.g1}
                  onChange={(v) => set("g1", v)}
                  suffix="%"
                  hint={basis?.h10 != null ? `H${basis.h10_years ?? 10}: ${pct(basis.h10, 1)}` : "No growth history"}
                />
                <div className="border-t border-line pt-1.5">
                  <div className="eyebrow">Growth value</div>
                  <div className="text-[14px] font-semibold text-ink tabular-nums">{model ? money(model.result.growthValue, cur) : "—"}</div>
                </div>
              </div>
              <div className="space-y-3 rounded-md border border-line bg-canvas p-4">
                <div className="text-[13px] font-semibold text-ink">Terminal stage</div>
                <Stepper label="Years (m)" value={params.m} onChange={(v) => set("m", Math.round(v))} min={0} max={50} />
                <Stepper label="Growth (g2)" value={params.g2} onChange={(v) => set("g2", v)} suffix="%" />
                <div className="border-t border-line pt-1.5">
                  <div className="eyebrow">Terminal value</div>
                  <div className="text-[14px] font-semibold text-ink tabular-nums">{model ? money(model.result.terminalValue, cur) : "—"}</div>
                </div>
              </div>
            </div>

            {/* TBV */}
            <label className="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-4 py-3">
              <span className="flex items-center gap-2 text-[12px] text-ink-2">
                <input
                  type="checkbox"
                  checked={params.addTbv}
                  disabled={inputs.tbv == null}
                  onChange={(e) => set("addTbv", e.target.checked)}
                  className="size-3.5 accent-spruce"
                />
                Add tangible book value to fair value
              </span>
              <span className="text-[12px] text-ink tabular-nums" title={inputs.tbv_as_of ? `As of ${inputs.tbv_as_of}` : undefined}>
                {inputs.tbv != null ? money(inputs.tbv, cur) : "n/a"}
              </span>
            </label>

            <button
              type="button"
              onClick={() => setParams(defaults(inputs, params.basis))}
              className="btn-secondary btn-sm w-full"
            >
              Reset defaults
            </button>

            {/* Warnings */}
            <div className="space-y-1.5 empty:hidden">
              {params.g2 >= params.d && <Warning>Terminal growth (g2) is at or above the discount rate (d): the model doesn&apos;t converge, so the value is meaningless.</Warning>}
              {params.e0 != null && params.e0 <= 0 && <Warning>E0 is zero or negative — a DCF isn&apos;t meaningful for negative earnings.</Warning>}
              {params.e0 == null && <Warning>No {basis?.label ?? "value"} in this company&apos;s filings. Pick another basis or enter E0 by hand.</Warning>}
              {!inputs.price_comparable && <Warning>{inputs.price_note ?? "The price can't be compared with the per-share figures"} — margin of safety is hidden.</Warning>}
            </div>

            {/* Outputs */}
            {model && (
              <div className="rounded-md border border-line bg-canvas p-4">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="eyebrow">Price</div>
                    <div className="text-[13px] font-semibold text-ink tabular-nums">{price != null ? money(price, cur) : "—"}</div>
                  </div>
                  <div>
                    <div className="eyebrow">Fair value</div>
                    <div className="type-big-figure !text-[22px] !leading-7 text-spruce">{money(model.result.fairValue, cur)}</div>
                  </div>
                  <div>
                    <div className="eyebrow">Margin of safety</div>
                    <div
                      className={`text-[13px] font-semibold tabular-nums ${
                        model.mos == null ? "text-ink-3" : model.mos >= 0 ? "text-gain" : "text-loss"
                      }`}
                    >
                      {model.mos == null ? "n/a" : pct(model.mos * 100)}
                    </div>
                  </div>
                </div>
                <AnimatePresence initial={false} mode="wait">
                  {model.mos != null && (
                    <motion.div
                      key={model.mos >= 0 ? "under" : "over"}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className={`pill mx-auto mt-3 w-fit ${model.mos >= 0 ? "bg-gain-bg text-gain" : "bg-loss-bg text-loss"}`}
                    >
                      {model.mos >= 0 ? "Undervalued" : "Overvalued"}
                    </motion.div>
                  )}
                </AnimatePresence>
                {price != null && inputs.price_comparable && model.result.fairValue > 0 && (
                  <Gauge price={price} fairValue={model.result.fairValue} currency={cur} />
                )}

                {/* Reverse DCF */}
                {inputs.price_comparable && price != null && (
                  <div className="border-t border-line pt-2 text-[13px] text-ink-3">
                    <span className="text-ink-2">Reverse DCF:</span>{" "}
                    {model.implied == null ? (
                      "no growth rate between −99% and 200% reaches the price"
                    ) : (
                      <>
                        the price implies <span className="font-semibold text-ink">{pct(model.implied * 100)}</span> growth for {model.p.n} years
                        {basis?.h10 != null && (
                          <>
                            {" "}
                            vs. {pct(basis.h10, 1)} historically —{" "}
                            <span className={model.implied * 100 <= basis.h10 ? "text-gain" : "text-caution"}>
                              {model.implied * 100 <= basis.h10 ? "could be achievable" : "may be hard to achieve"}
                            </span>
                          </>
                        )}
                        .
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Predictability */}
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="text-ink-3">Predictability</span>
              <span className="flex items-center gap-2">
                <Stars value={inputs.predictability} />
                {inputs.predictability == null && <span className="text-ink-3">not available</span>}
              </span>
            </div>
            {inputs.predictability != null && inputs.predictability <= 1 && <Warning>DCF is unreliable for unpredictable businesses.</Warning>}

            {/* Projection table */}
            {model && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowTable((s) => !s)}
                  aria-expanded={showTable}
                  className="flex w-full items-center justify-between text-[13px] font-medium text-ink-2 hover:text-ink"
                >
                  Year-by-year projection
                  <span aria-hidden className={`transition-transform ${showTable ? "rotate-90" : ""}`}>
                    ›
                  </span>
                </button>
                {showTable && (
                  <div className="mt-2 overflow-x-auto rounded-md border border-line">
                    <table className="w-full text-[12px] tabular-nums">
                      <thead className="border-b border-line-strong bg-panel text-ink-3 uppercase [&_th]:text-[11px] [&_th]:font-bold [&_th]:tracking-[0.09em]">
                        <tr>
                          <th className="px-1.5 py-1 text-left font-medium">Yr</th>
                          <th className="px-1.5 py-1 text-left font-medium">Stage</th>
                          <th className="px-1.5 py-1 text-right font-medium">Earnings</th>
                          <th className="px-1.5 py-1 text-right font-medium">1/(1+d)ᵗ</th>
                          <th className="px-1.5 py-1 text-right font-medium">PV</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.rows.map((r) => (
                          <tr key={r.year} className="border-t border-line text-ink-2">
                            <td className="px-1.5 py-0.5">{r.year}</td>
                            <td className={`px-1.5 py-0.5 ${r.stage === "growth" ? "text-spruce" : "text-ink-3"}`}>{r.stage === "growth" ? "Growth" : "Terminal"}</td>
                            <td className="px-1.5 py-0.5 text-right">{r.earnings.toFixed(2)}</td>
                            <td className="px-1.5 py-0.5 text-right">{r.discountFactor.toFixed(4)}</td>
                            <td className="px-1.5 py-0.5 text-right">{r.presentValue.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Saved fair values */}
            <div className="border-t border-line pt-3">
              <div className="flex items-center justify-between">
                <h3 className="eyebrow">Saved fair values</h3>
                <button
                  type="button"
                  disabled={!model || !Number.isFinite(model.result.fairValue)}
                  onClick={() =>
                    model &&
                    save({
                      ticker: inputs.symbol,
                      basis: params.basis,
                      d: params.d,
                      g1: params.g1,
                      g2: params.g2,
                      fairValue: model.result.fairValue,
                      mos: model.mos,
                      currency: cur,
                    })
                  }
                  className="btn-ghost btn-sm"
                >
                  + Save scenario
                </button>
              </div>
              {saved.length === 0 ? (
                <p className="mt-1.5 text-[12px] text-ink-3">Nothing saved yet.</p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {saved.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 rounded-md border border-line bg-canvas px-3 py-2 text-[13px]">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono font-semibold text-spruce">{s.ticker}</span>
                          <span className="text-ink-3">{BASIS_LABELS[s.basis]}</span>
                        </div>
                        <div className="truncate text-[12px] text-ink-3">
                          d {s.d}% · g1 {s.g1}% · g2 {s.g2}%
                        </div>
                      </div>
                      <div className="text-right tabular-nums">
                        <div className="text-ink">{money(s.fairValue, s.currency)}</div>
                        <div className={s.mos == null ? "text-ink-3" : s.mos >= 0 ? "text-gain" : "text-loss"}>
                          {s.mos == null ? "MoS n/a" : pct(s.mos * 100, 1)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(s.id)}
                        aria-label={`Remove saved ${s.ticker} scenario`}
                        className="rounded px-1 text-ink-3 hover:bg-subtle hover:text-ink"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Sources & gaps */}
            <details className="text-[12px] text-ink-3">
              <summary className="cursor-pointer text-ink-3 hover:text-ink-2">Data sources &amp; gaps</summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-snug">
                <li>
                  Statements: {inputs.source}
                  {inputs.fx_rate != null && ` (reported in ${inputs.reporting_currency}, converted at ${inputs.fx_rate.toPrecision(5)})`}. Price:{" "}
                  {inputs.price_source ?? "—"}. 10Y Treasury {inputs.t10.toFixed(2)}% ({inputs.t10_source}, {inputs.t10_as_of}).
                </li>
                {inputs.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
