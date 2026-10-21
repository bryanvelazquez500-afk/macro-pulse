"use client";

import { LayoutGroup } from "framer-motion";
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { DataDrawers } from "@/components/DataDrawers";
import { DcfCalculator } from "@/components/DcfCalculator";
import { EquityDiscovery } from "@/components/EquityDiscovery";
import { IntrinsicValuationStation } from "@/components/IntrinsicValuationStation";
import { SidePanel } from "@/components/SidePanel";
import { FinancialsTable, VarianceLegend } from "@/components/FinancialsTable";
import { HorizontalAnalysis } from "@/components/HorizontalAnalysis";
import { NoticeToast } from "@/components/NoticeToast";
import { NewsTicker } from "@/components/NewsTicker";
import { PeerPills } from "@/components/PeerPills";
import { InjectBanner, SupplyChainNetwork } from "@/components/SupplyChainNetwork";
import { PulseBotTour } from "@/components/PulseBotTour";
import { TickerSuggestions } from "@/lib/useTickerSuggestions";
import { ValuationPanel } from "@/components/ValuationPanel";
import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { ViewPanel, ViewTab, ViewTabs } from "@/components/ViewTabs";
import {
  ComparisonProvider,
  MAX_COMPARE,
  symbolOf,
  useComparison,
} from "@/lib/comparisonStore";
import { normalizeTicker } from "@/lib/portfolioStore";
import { ValuationAssumptionsProvider } from "@/lib/valuationAssumptions";

function Section({
  title,
  meta,
  note,
  children,
}: {
  title: string;
  meta?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="text-[13px] font-medium tracking-tight text-ink">
          {title}
        </h3>
        {meta && <div className="text-[11px] text-ink-3">{meta}</div>}
      </div>
      {children}
      {note && <p className="mt-2 text-[11px] text-ink-3">{note}</p>}
    </section>
  );
}

type AnalysisView = "matrix" | "discovery" | "supply";

const ANALYSIS_VIEWS: ViewTab<AnalysisView>[] = [
  {
    key: "matrix",
    label: "Raw Financial Statements Matrix",
    short: "Statements",
    hint: "Side-by-side statements, ratios and forensic scores",
  },
  {
    key: "discovery",
    label: "Equity Discovery",
    short: "Discovery",
    hint: "Scout world markets on an interactive map",
  },
  {
    key: "supply",
    label: "Supply Chain Network",
    short: "Supply Chain",
    hint: "Suppliers and clients as an interactive web",
  },
];

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
  const {
    entries,
    focused,
    focusedId,
    period,
    notice,
    isLoading,
    add,
    remove,
    focus,
    setPeriod,
    dismissNotice,
  } = useComparison();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AnalysisView>("matrix");
  // The guided tour exists only while open: the yellow help button mounts it, Exit/Esc unmounts it.
  const [touring, setTouring] = useState(false);

  // The discovery map (and its 120 KB of geometry) loads the first time its tab is opened, then stays mounted.
  const [discoveryOpened, setDiscoveryOpened] = useState(false);
  // Same for the supply-chain graph (its canvas engine is a separate download).
  const [supplyOpened, setSupplyOpened] = useState(false);
  const [injected, setInjected] = useState<string | null>(null);
  const clearInjected = useCallback(() => setInjected(null), []);

  function changeView(next: AnalysisView) {
    if (next === "discovery") setDiscoveryOpened(true);
    if (next === "supply") setSupplyOpened(true);
    setView(next);
  }
  const searchRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  // The header's height changes (peer pills appear once a company is focused, rows wrap on narrow
  // screens). Publish it as --header-h so the sticky rails sit just below it and fit the viewport.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--header-h",
        `${el.offsetHeight}px`,
      );
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Adding a new column shows the matrix, so its slide-in (and a peer pill's flight) has somewhere to land. */
  /** From the supply-chain web: add without leaving the tab, and confirm with a green banner. */
  function injectFromSupplyChain(ticker: string) {
    const id = normalizeTicker(ticker);
    const present = entries.some((e) => e.id === id || (id && e.profile?.tickers.includes(id)));
    if (id && !present && entries.length < MAX_COMPARE) setInjected(`${id} injected into Financial Comparison Tab`);
    else if (present) setInjected(`${id} is already in the Financial Comparison Tab`);
    add(ticker); // a full comparison shows the usual "matrix is full" warning instead
    // Adding focuses the new column; keep the current focus so the web you're exploring doesn't re-centre.
    if (focusedId) focus(focusedId);
  }

  function addToComparison(input: string) {
    const id = normalizeTicker(input);
    const present = entries.some(
      (e) => e.id === id || (id && e.profile?.tickers.includes(id)),
    );
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
      <header
        ref={headerRef}
        className="sticky top-0 z-30 border-b border-white/5 bg-macropulse-obsidian/80 backdrop-blur-md"
      >
        <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span
              className="size-2 translate-y-[-1px] rounded-full bg-macropulse-cyan shadow-[0_0_10px_var(--color-macropulse-cyan)]"
              aria-hidden
            />
            <span className="text-[13px] font-semibold tracking-[0.18em] text-ink uppercase">
              MacroPulse
            </span>
          </div>
          <form
            id="tour-search"
            onSubmit={onSubmit}
            className="flex flex-1 flex-wrap items-center gap-2 sm:flex-nowrap"
          >
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                entries.length >= MAX_COMPARE
                  ? "Comparison full — remove a column"
                  : "Add ticker or CIK to compare — MSFT, 320193"
              }
              aria-label="Add a ticker or CIK to the comparison"
              list="header-ticker-suggestions"
              maxLength={16}
              className="field min-w-0 flex-1 font-mono uppercase sm:max-w-md"
            />
            <TickerSuggestions id="header-ticker-suggestions" query={query} />
            <button
              type="submit"
              disabled={!query.trim()}
              className="btn-primary"
            >
              Add
            </button>
            <span
              className="font-mono text-[11px] text-ink-3"
              aria-live="polite"
            >
              {entries.length}/{MAX_COMPARE}
            </span>
            <div
              className="flex rounded-md border border-line-strong p-0.5"
              role="group"
              aria-label="Period"
            >
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
            {isLoading && (
              <span className="text-[11px] text-ink-3">Loading…</span>
            )}
          </form>
          <div id="tour-drawers">
            <DataDrawers entry={focused} />
          </div>
          <span className="hidden text-[11px] text-ink-4 2xl:block">
            Source · SEC EDGAR
          </span>
        </div>
        {focused && (
          <div className="mx-auto w-full max-w-[1920px] px-4 pb-3 sm:px-6">
            {/* Keyed by company so suggestions reload when focus moves. */}
            <PeerPills
              key={focused.id}
              focusId={focused.id}
              entries={entries}
              onAdd={addToComparison}
            />
          </div>
        )}
        <NewsTicker ticker={focusedReady ? symbolOf(focusedReady) : null} />
      </header>
      <NoticeToast notice={notice} onDismiss={dismissNotice} />
      <InjectBanner message={injected} onDone={clearInjected} />

      <button
        id="help-tour-trigger"
        type="button"
        onClick={() => {
          setView("matrix"); // the tour's steps live on the statements view
          setTouring(true);
        }}
        aria-label="Start the guided tour"
        title="Guided tour"
        className="fixed right-6 bottom-6 z-40 flex items-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-[13px] font-bold text-black transition-transform hover:scale-105 hover:bg-yellow-300 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
      >
        <span
          aria-hidden
          className="grid size-5 place-items-center rounded-full bg-black text-[12px] font-black text-yellow-400"
        >
          ?
        </span>
        Tour
      </button>
      {touring && (
        <PulseBotTour
          onView={changeView}
          // Focus isn't returned to the help button: Space (the tour key) would press it and reopen the tour.
          onClose={() => {
            setTouring(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        />
      )}

      <div className="mx-auto grid w-full max-w-[1920px] flex-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_320px]">
        <SidePanel label="DCF calculator and watchlist" stickyFrom="lg">
          <div id="tour-dcf">
            <DcfCalculator symbol={focused ? symbolOf(focused) : null} />
          </div>
          <div id="tour-watchlist">
            <WatchlistSidebar
              activeTicker={focused ? symbolOf(focused) : null}
              onSelect={addToComparison}
            />
          </div>
        </SidePanel>

        <main className="min-w-0 space-y-12">
          <section>
            <p className="eyebrow mb-2">
              Cross-sectional comparison · {period}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-ink">
              {entries.length
                ? entries.map(symbolOf).join("  ·  ")
                : "No companies selected"}
            </h1>
            <p className="mt-2 text-[12px] text-ink-3">
              Add up to {MAX_COMPARE} companies. Click a column header to focus
              it — the Intrinsic Valuation Station, valuation, news and the
              header&apos;s lineage and filings drawers follow the focused
              company.
            </p>
            {/* The view switcher doubles as the header's bottom rule. */}
            <div id="tour-tabs" className="mt-6">
              <ViewTabs
                tabs={ANALYSIS_VIEWS}
                active={view}
                onChange={changeView}
                label="Analysis view"
              />
            </div>

            <div className="mt-6">
              <ViewPanel view="matrix" active={view === "matrix"}>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <VarianceLegend thresholdPct={threshold} />
                    <a
                      href="#horizontal-analysis"
                      className="mp-interactive inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium text-macropulse-cyan ring-1 ring-macropulse-cyan/40 ring-inset hover:bg-macropulse-cyan/10"
                    >
                      Horizontal & vertical analysis <span aria-hidden>↓</span>
                    </a>
                  </div>
                  <div id="tour-matrix">
                    <FinancialsTable
                      entries={entries}
                      focusedId={focusedId}
                      periodType={period}
                      onFocus={focus}
                      onRemove={remove}
                      onAddClick={() => searchRef.current?.focus()}
                    />
                  </div>
                  <p className="text-[11px] text-ink-3">
                    Each column shows that company&apos;s own fiscal period;
                    variances compare it with the same period a year earlier. *
                    Fallback method or not meaningful — hover any value for its
                    source tag and details.
                  </p>
                  <HorizontalAnalysis
                    entries={entries}
                    periodType={period}
                    focusedId={focusedId}
                  />
                </div>
              </ViewPanel>

              <ViewPanel view="discovery" active={view === "discovery"}>
                {discoveryOpened && (
                  <EquityDiscovery
                    onAnalyze={(symbol) => {
                      // The arrow adds the stock to the 3-company comparison and jumps to the raw financials.
                      addToComparison(symbol);
                      setView("matrix");
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  />
                )}
              </ViewPanel>

              <ViewPanel view="supply" active={view === "supply"}>
                {supplyOpened && (
                  <div id="tour-supply">
                  <SupplyChainNetwork
                    focusTicker={focused ? symbolOf(focused) : null}
                    onInject={injectFromSupplyChain}
                  />
                  </div>
                )}
              </ViewPanel>
            </div>
          </section>

          {focusedReady?.profile && focusedReady.financials && (
            <>
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-8">
                <span className="eyebrow">Focused</span>
                <div
                  className="flex gap-1"
                  role="tablist"
                  aria-label="Focused company"
                >
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
                  {focusedReady.profile.sic_description &&
                    ` · ${focusedReady.profile.sic_description}`}
                </span>
              </div>

              {focusedReady.annual && (
                <Section
                  title="Valuation"
                  meta="Equity DCF at the CAPM cost of equity · drag assumptions to re-price"
                >
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
          <SidePanel label="Intrinsic valuation">
            <div id="tour-ivs">
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
                <div className="panel px-4 py-6 text-[13px] text-ink-3">
                  Focus a company to run the Intrinsic Valuation Station.
                </div>
              )}
            </div>
          </SidePanel>
        </div>
      </div>
    </div>
  );
}
