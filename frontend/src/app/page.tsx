"use client";

import { LayoutGroup } from "framer-motion";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";

import { ContextPane } from "@/components/ContextPane";
import { DataDrawers } from "@/components/DataDrawers";
import { EquityDiscovery } from "@/components/EquityDiscovery";
import { IntrinsicValuationStation } from "@/components/IntrinsicValuationStation";
import { SidePanel } from "@/components/SidePanel";
import { FinancialsTable, VarianceLegend } from "@/components/FinancialsTable";
import { LegendChecklist } from "@/components/LegendChecklist";
import { NoticeToast } from "@/components/NoticeToast";
import { PeerPills } from "@/components/PeerPills";
import { ValuationPanel } from "@/components/ValuationPanel";
import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { ViewPanel, ViewTab, ViewTabs } from "@/components/ViewTabs";
import { CompanyEntry, ComparisonProvider, MAX_COMPARE, symbolOf, useComparison } from "@/lib/comparisonStore";
import { normalizeTicker } from "@/lib/portfolioStore";
import { ValuationAssumptionsProvider } from "@/lib/valuationAssumptions";

function Section({ title, meta, note, children }: { title: string; meta?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="text-[13px] font-medium tracking-tight text-ink">{title}</h3>
        {meta && <div className="text-[11px] text-ink-3">{meta}</div>}
      </div>
      {children}
      {note && <p className="mt-2 text-[11px] text-ink-3">{note}</p>}
    </section>
  );
}

type AnalysisView = "matrix" | "strategy" | "discovery";

const ANALYSIS_VIEWS: ViewTab<AnalysisView>[] = [
  {
    key: "matrix",
    label: "Raw Financial Statements Matrix",
    short: "Statements",
    hint: "Side-by-side statements, ratios and forensic scores",
  },
  {
    key: "strategy",
    label: "Legendary Strategy Intelligence Shell",
    short: "Strategy",
    hint: "Buffett, Lynch, Munger and Ackman checklists",
  },
  { key: "discovery", label: "Equity Discovery", short: "Discovery", hint: "Scout world markets on an interactive map" },
];

/** View B: the focused company scored against each legend's rules, with its own company switcher. */
function StrategyShell({
  ready,
  focusedId,
  onFocus,
  replayKey,
}: {
  ready: CompanyEntry[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  replayKey: number;
}) {
  const focused = ready.find((e) => e.id === focusedId) ?? null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Evaluating</span>
          {ready.length > 0 ? (
            <div className="flex gap-1" role="group" aria-label="Company to evaluate">
              {ready.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={e.id === focusedId}
                  onClick={() => onFocus(e.id)}
                  className={`mp-interactive relative rounded-md px-2.5 py-1 font-mono text-xs ${e.id === focusedId ? "bg-inverse text-on-inverse" : "text-ink-3 hover:text-ink"}`}
                >
                  {symbolOf(e)}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-[12px] text-ink-3">No companies loaded yet.</span>
          )}
          {focused?.profile && <span className="text-[12px] text-ink-3">{focused.profile.name}</span>}
        </div>
        <span className="text-[11px] text-ink-3">Buffett · Lynch · Munger · Ackman</span>
      </div>

      {focused ? (
        // Keyed by company so the checklist refetches when focus moves.
        <LegendChecklist key={focused.id} identifier={focused.id} replayKey={replayKey} />
      ) : (
        <p className="panel px-4 py-6 text-center text-[13px] text-ink-3">
          {ready.length ? "Select a company above to run the legend checklists." : "Add a company to run the legend checklists."}
        </p>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <ComparisonProvider initial={["AAPL"]}>
      {/* One layout group spans header and matrix so peer pills can morph into column headers. */}
      <LayoutGroup>
        {/* Valuation sliders are shared by the center Valuation panel and the side panel's Station. */}
        <ValuationAssumptionsProvider>
          <Station />
        </ValuationAssumptionsProvider>
      </LayoutGroup>
    </ComparisonProvider>
  );
}

function Station() {
  const { entries, focused, focusedId, period, notice, isLoading, add, remove, focus, setPeriod, dismissNotice } = useComparison();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AnalysisView>("matrix");
  // Bumped each time the Strategy view is opened, so its checks ripple in again.
  const [strategyEntries, setStrategyEntries] = useState(0);

  // The discovery map (and its 120 KB of geometry) loads the first time its tab is opened, then stays mounted.
  const [discoveryOpened, setDiscoveryOpened] = useState(false);

  function changeView(next: AnalysisView) {
    if (next === "strategy" && view !== "strategy") setStrategyEntries((n) => n + 1);
    if (next === "discovery") setDiscoveryOpened(true);
    setView(next);
  }
  const searchRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  // The header's height changes (peer pills appear once a company is focused, rows wrap on narrow
  // screens). Publish it as --header-h so the sticky rails sit just below it and fit the viewport.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Adding a new column shows the matrix, so its slide-in (and a peer pill's flight) has somewhere to land. */
  function addToComparison(input: string) {
    const id = normalizeTicker(input);
    const present = entries.some((e) => e.id === id || (id && e.profile?.tickers.includes(id)));
    if (id && !present) setView("matrix");
    add(input);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    addToComparison(query);
    setQuery("");
  }

  const ready = entries.filter((e) => e.status === "ready");
  const threshold = ready[0]?.financials?.variance_threshold_pct ?? 10;
  const focusedReady = focused?.status === "ready" ? focused : null;

  return (
    // Main dashboard container: obsidian canvas; panels inside are glass sheets (.panel).
    <div className="flex min-h-full flex-1 flex-col bg-macropulse-obsidian">
      <header ref={headerRef} className="sticky top-0 z-30 border-b border-white/5 bg-macropulse-obsidian/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="size-2 translate-y-[-1px] rounded-full bg-macropulse-cyan shadow-[0_0_10px_var(--color-macropulse-cyan)]" aria-hidden />
            <span className="text-[13px] font-semibold tracking-[0.18em] text-ink uppercase">MacroPulse</span>
          </div>
          <form onSubmit={onSubmit} className="flex flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                entries.length >= MAX_COMPARE ? "Comparison full — remove a column" : "Add ticker or CIK to compare — MSFT, 320193"
              }
              aria-label="Add a ticker or CIK to the comparison"
              maxLength={16}
              className="field min-w-0 flex-1 font-mono uppercase sm:max-w-md"
            />
            <button type="submit" disabled={!query.trim()} className="btn-primary">
              Add
            </button>
            <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
              {entries.length}/{MAX_COMPARE}
            </span>
            <div className="flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Period">
              {(["annual", "quarterly"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  aria-pressed={period === p}
                  className={`rounded-[5px] px-3 py-1.5 text-xs capitalize transition-colors ${period === p ? "bg-inverse text-on-inverse" : "text-ink-3 hover:text-ink"}`}
                >
                  {p}
                </button>
              ))}
            </div>
            {isLoading && <span className="text-[11px] text-ink-3">Loading…</span>}
          </form>
          <DataDrawers entry={focused} />
          <span className="hidden text-[11px] text-ink-4 2xl:block">Source · SEC EDGAR</span>
        </div>
        {focused && (
          <div className="mx-auto w-full max-w-[1920px] px-4 pb-3 sm:px-6">
            {/* Keyed by company so suggestions reload when focus moves. */}
            <PeerPills key={focused.id} focusId={focused.id} entries={entries} onAdd={addToComparison} />
          </div>
        )}
      </header>
      <NoticeToast notice={notice} onDismiss={dismissNotice} />

      <div className="mx-auto grid w-full max-w-[1920px] flex-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_320px]">
        <SidePanel label="Valuation and watchlist" stickyFrom="lg">
          {focusedReady?.annual ? (
            // Keyed by company: market inputs refetch and sync overrides reset when focus moves.
            <IntrinsicValuationStation
              key={focusedReady.id}
              companyId={focusedReady.id}
              symbol={symbolOf(focusedReady)}
              annualPeriods={focusedReady.annual.periods}
              currency={focusedReady.annual.currency}
            />
          ) : (
            <div className="panel px-4 py-6 text-[13px] text-ink-3">Focus a company to run the Intrinsic Valuation Station.</div>
          )}
          <WatchlistSidebar activeTicker={focused ? symbolOf(focused) : null} onSelect={addToComparison} />
        </SidePanel>

        <main className="min-w-0 space-y-12">
          <section>
            <p className="eyebrow mb-2">Cross-sectional comparison · {period}</p>
            <h1 className="text-3xl font-semibold tracking-tight text-ink">
              {entries.length ? entries.map(symbolOf).join("  ·  ") : "No companies selected"}
            </h1>
            <p className="mt-2 text-[12px] text-ink-3">
              Add up to {MAX_COMPARE} companies. Click a column header to focus it — the Intrinsic Valuation Station, valuation, news and
              the header&apos;s lineage and filings drawers follow the focused company.
            </p>
            {/* The view switcher doubles as the header's bottom rule. */}
            <div className="mt-6">
              <ViewTabs tabs={ANALYSIS_VIEWS} active={view} onChange={changeView} label="Analysis view" />
            </div>

            <div className="mt-6">
              <ViewPanel view="matrix" active={view === "matrix"}>
                <div className="space-y-4">
                  <VarianceLegend thresholdPct={threshold} />
                  <FinancialsTable
                    entries={entries}
                    focusedId={focusedId}
                    periodType={period}
                    onFocus={focus}
                    onRemove={remove}
                    onAddClick={() => searchRef.current?.focus()}
                  />
                  <p className="text-[11px] text-ink-3">
                    Each column shows that company&apos;s own fiscal period; variances compare it with the same period a year earlier. *
                    Fallback method or not meaningful — hover any value for its source tag and details.
                  </p>
                </div>
              </ViewPanel>

              <ViewPanel view="strategy" active={view === "strategy"}>
                <StrategyShell ready={ready} focusedId={focusedId} onFocus={focus} replayKey={strategyEntries} />
              </ViewPanel>

              <ViewPanel view="discovery" active={view === "discovery"}>
                {discoveryOpened && (
                  <EquityDiscovery
                    onAnalyze={(symbol) => {
                      addToComparison(symbol);
                      setView("matrix");
                    }}
                  />
                )}
              </ViewPanel>
            </div>
          </section>

          {focusedReady?.profile && focusedReady.financials && (
            <>
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-8">
                <span className="eyebrow">Focused</span>
                <div className="flex gap-1" role="tablist" aria-label="Focused company">
                  {ready.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      role="tab"
                      aria-selected={e.id === focusedId}
                      onClick={() => focus(e.id)}
                      className={`mp-interactive relative rounded-md px-2.5 py-1 font-mono text-xs ${e.id === focusedId ? "bg-inverse text-on-inverse" : "text-ink-3 hover:text-ink"}`}
                    >
                      {symbolOf(e)}
                    </button>
                  ))}
                </div>
                <span className="text-[12px] text-ink-3">
                  {focusedReady.profile.name}
                  {focusedReady.profile.cik
                    ? ` · CIK ${focusedReady.profile.cik}`
                    : ` · ${focusedReady.profile.exchanges[0] ?? focusedReady.profile.symbol}`}
                  {focusedReady.profile.sic_description && ` · ${focusedReady.profile.sic_description}`}
                </span>
              </div>

              {focusedReady.annual && (
                <Section title="Valuation" meta="5-year DCF · drag assumptions to re-price">
                  <ValuationPanel
                    key={focusedReady.annual.cik ?? focusedReady.annual.symbol}
                    companyId={focusedReady.id}
                    annualPeriods={focusedReady.annual.periods}
                    currency={focusedReady.annual.currency}
                  />
                </Section>
              )}
            </>
          )}
        </main>

        <div className="lg:col-start-2 xl:col-start-3 xl:row-start-1">
          <SidePanel label="Market news">
            <ContextPane ticker={focusedReady ? symbolOf(focusedReady) : null} />
          </SidePanel>
        </div>
      </div>
    </div>
  );
}
