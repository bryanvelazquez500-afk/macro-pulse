"use client";

import { LayoutGroup, motion } from "framer-motion";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DataDrawers } from "@/components/DataDrawers";
import { DcfCalculator } from "@/components/DcfCalculator";
import { EquityDiscovery } from "@/components/EquityDiscovery";
import { IntrinsicValuationStation } from "@/components/IntrinsicValuationStation";
import { FinancialsTable, VarianceLegend } from "@/components/FinancialsTable";
import { HorizontalAnalysis } from "@/components/HorizontalAnalysis";
import { NoticeToast } from "@/components/NoticeToast";
import { NewsTicker } from "@/components/NewsTicker";
import { PeerPills } from "@/components/PeerPills";
import {
  InjectBanner,
  SupplyChainNetwork,
} from "@/components/SupplyChainNetwork";
import { PulseBotTour } from "@/components/PulseBotTour";
import { TickerSuggestions } from "@/lib/useTickerSuggestions";
import { ServerWakeNotice } from "@/components/ServerWakeNotice";
import { ValuationPanel } from "@/components/ValuationPanel";
import { Segmented } from "@/components/Segmented";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WatchlistMenu } from "@/components/WatchlistMenu";
import { ViewPanel, ViewTab, ViewTabs } from "@/components/ViewTabs";
import {
  ComparisonProvider,
  MAX_COMPARE,
  symbolOf,
  useComparison,
} from "@/lib/comparisonStore";
import { flow } from "@/lib/motion";
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
        <h3 className="type-card text-ink">{title}</h3>
        {meta && <div className="text-[13px] text-ink-3">{meta}</div>}
      </div>
      {children}
      {note && <p className="mt-2 text-[13px] text-ink-3">{note}</p>}
    </section>
  );
}

type AnalysisView = "matrix" | "valuation" | "discovery" | "supply";

const ANALYSIS_VIEWS: ViewTab<AnalysisView>[] = [
  {
    key: "matrix",
    label: "Compare",
    short: "Compare",
    hint: "Financial statements side by side, plus horizontal and vertical analysis",
  },
  {
    key: "valuation",
    label: "Valuation",
    short: "Value",
    hint: "Equity DCF, the DCF calculator and the Intrinsic Valuation Station for the focused company",
  },
  {
    key: "discovery",
    label: "Discover",
    short: "Discover",
    hint: "Scout world markets on an interactive map",
  },
  {
    key: "supply",
    label: "Supply chain",
    short: "Supply",
    hint: "Suppliers and clients as an interactive web",
  },
];

export default function Home() {
  return (
    <ComparisonProvider initial={["AAPL"]}>
      {/* One layout group spans header and matrix so peer pills can morph into column headers. */}
      <LayoutGroup>
        {/* Valuation sliders are shared by the Valuation panel and the Intrinsic Valuation Station. */}
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
  // screens). Publish it as --header-h so anchored sections scroll clear of it.
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
    const present = entries.some(
      (e) => e.id === id || (id && e.profile?.tickers.includes(id)),
    );
    if (id && !present && entries.length < MAX_COMPARE)
      setInjected(`${id} injected into Financial Comparison Tab`);
    else if (present)
      setInjected(`${id} is already in the Financial Comparison Tab`);
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

  const focusBar = focusedReady?.profile && (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="seg-track" role="tablist" aria-label="Focused company">
        {ready.map((e) => (
          <button
            key={e.id}
            type="button"
            role="tab"
            aria-selected={e.id === focusedId}
            onClick={() => focus(e.id)}
            className="seg-item font-mono"
          >
            {e.id === focusedId && (
              <motion.span
                layoutId="focus-thumb"
                className="seg-thumb"
                transition={flow(2)}
              />
            )}
            <span>{symbolOf(e)}</span>
          </button>
        ))}
      </div>
      <span className="text-[15px] text-ink-3">
        <span className="font-semibold text-ink">
          {focusedReady.profile.name}
        </span>
        {focusedReady.profile.sic_description &&
          ` · ${focusedReady.profile.sic_description}`}
      </span>
    </div>
  );

  return (
    // Main dashboard container: the ledger canvas; cards inside are .panel sheets.
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <header
        ref={headerRef}
        className="sticky top-0 z-30 border-b border-line bg-panel shadow-1"
      >
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            {/* Logo: one flowing pulse stroke in a spruce tile. */}
            <span
              aria-hidden
              className="grid size-[26px] place-items-center rounded-[8px] bg-spruce text-on-spruce"
            >
              <svg viewBox="0 0 26 26" className="size-[22px]" fill="none">
                <path
                  d="M3 14c2.5 0 3.2-.2 4.4-2.2C8.6 9.7 9.4 6 10.6 6c1.4 0 1.7 13.5 3.3 13.5 1.3 0 1.6-7.3 3-7.3 1 0 1.3 1.8 2.6 1.8H23"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="text-[18px] font-extrabold tracking-[-0.01em] text-ink">
              MacroPulse
            </span>
          </div>
          <form
            id="tour-search"
            onSubmit={onSubmit}
            className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-1 sm:flex-nowrap"
          >
            <div className="relative min-w-0 flex-1 max-sm:min-w-[62%] sm:max-w-md">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  entries.length >= MAX_COMPARE
                    ? "Comparison full — remove a column"
                    : "Add a ticker or CIK — MSFT, 320193"
                }
                aria-label="Add a ticker or CIK to the comparison"
                list="header-ticker-suggestions"
                maxLength={16}
                className="field field-pill w-full pr-14 font-mono uppercase placeholder:font-sans placeholder:normal-case"
              />
              <span
                className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[12px] font-semibold text-ink-3"
                aria-live="polite"
              >
                {entries.length}/{MAX_COMPARE}
              </span>
            </div>
            <TickerSuggestions id="header-ticker-suggestions" query={query} />
            <button
              type="submit"
              disabled={!query.trim()}
              className="btn-primary"
            >
              Add
            </button>
            <Segmented
              label="Period"
              role="group"
              value={period}
              onChange={setPeriod}
              options={[
                { key: "annual", label: "Annual" },
                { key: "quarterly", label: "Quarterly" },
              ]}
            />
            {isLoading && (
              <span className="text-[13px] text-ink-3">Loading…</span>
            )}
          </form>
          <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
            <div id="tour-watchlist">
              <WatchlistMenu
                activeTicker={focused ? symbolOf(focused) : null}
                onSelect={addToComparison}
              />
            </div>
            <div id="tour-drawers">
              <DataDrawers entry={focused} />
            </div>
            <ThemeToggle />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1280px] px-4 pb-3 sm:px-6">
          <NewsTicker ticker={focusedReady ? symbolOf(focusedReady) : null} />
        </div>
      </header>
      <ServerWakeNotice />
      <NoticeToast notice={notice} onDismiss={dismissNotice} />
      <InjectBanner message={injected} onDone={clearInjected} />

      <button
        id="help-tour-trigger"
        type="button"
        onClick={() => {
          setView("matrix"); // the tour starts on the Compare view
          setTouring(true);
        }}
        aria-label="Start the guided tour"
        title="Guided tour"
        className="fixed right-[calc(24px+env(safe-area-inset-right))] bottom-[calc(24px+env(safe-area-inset-bottom))] z-40 flex items-center gap-2 rounded-full bg-brass py-2.5 pr-5 pl-2.5 text-[14px] font-bold text-on-brass shadow-float transition-transform duration-[var(--dur-1)] ease-[var(--ease-flow)] hover:-translate-y-0.5"
      >
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-full bg-on-brass text-[14px] font-extrabold text-brass"
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

      {/* One full-width column: every feature gets the whole screen, and the page is the only scroll. */}
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-10 pb-28 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="eyebrow mb-1.5">
              Comparison ·{" "}
              {period === "annual" ? "annual reports" : "quarterly reports"}
            </p>
            <h1 className="type-hero truncate text-ink max-sm:!text-[34px] max-sm:!leading-[40px]">
              {entries.length
                ? entries.map(symbolOf).join("  ·  ")
                : "No companies selected"}
            </h1>
          </div>
          {focused && (
            // Keyed by company so suggestions reload when focus moves.
            <PeerPills
              key={focused.id}
              focusId={focused.id}
              entries={entries}
              onAdd={addToComparison}
            />
          )}
        </div>

        <div id="tour-tabs" className="mt-8">
          <ViewTabs
            tabs={ANALYSIS_VIEWS}
            active={view}
            onChange={changeView}
            label="Section"
          />
        </div>

        <div className="mt-8">
          <ViewPanel view="matrix" active={view === "matrix"}>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <VarianceLegend thresholdPct={threshold} />
                <span className="text-[13px] text-ink-3">
                  Click a column header to focus that company
                </span>
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
              <p className="text-[13px] text-ink-3">
                Each column shows that company&apos;s own fiscal period;
                variances compare it with the same period a year earlier. *
                Fallback method or not meaningful — hover any value for its
                source tag and details.
              </p>
              <div className="pt-10">
                <HorizontalAnalysis
                  entries={entries}
                  periodType={period}
                  focusedId={focusedId}
                />
              </div>
            </div>
          </ViewPanel>

          <ViewPanel view="valuation" active={view === "valuation"}>
            {focusedReady?.annual ? (
              <div className="space-y-8">
                {focusBar}
                <Section
                  title="Equity DCF"
                  meta="Free cash flow to equity at the CAPM cost of equity · drag assumptions to re-price"
                >
                  <ValuationPanel
                    key={focusedReady.annual.cik ?? focusedReady.annual.symbol}
                    companyId={focusedReady.id}
                    annualPeriods={focusedReady.annual.periods}
                    currency={focusedReady.annual.currency}
                  />
                </Section>
                <div className="grid items-start gap-6 lg:grid-cols-2">
                  <div id="tour-dcf">
                    <DcfCalculator symbol={symbolOf(focusedReady)} />
                  </div>
                  <div id="tour-ivs">
                    {/* Keyed by company: market inputs refetch and sync overrides reset when focus moves. */}
                    <IntrinsicValuationStation
                      key={focusedReady.id}
                      companyId={focusedReady.id}
                      symbol={symbolOf(focusedReady)}
                      annualPeriods={focusedReady.annual.periods}
                      currency={focusedReady.annual.currency}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="panel px-6 py-12 text-center text-[15px] text-ink-3">
                Add a company to value it — the valuation tools follow the
                focused company.
              </div>
            )}
          </ViewPanel>

          <ViewPanel view="discovery" active={view === "discovery"}>
            {discoveryOpened && (
              <EquityDiscovery
                onAnalyze={(symbol) => {
                  // The arrow adds the stock to the comparison and jumps to the statements.
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
      </main>
    </div>
  );
}
