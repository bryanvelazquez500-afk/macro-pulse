"use client";

/**
 * App-wide comparison state: up to MAX_COMPARE active tickers, which one is focused
 * (drives the valuation, news, narrative and filings panels), and the period type.
 *
 * The reducer owns every rule (duplicates, the cap, focus) so rapid actions can't race;
 * a single effect fetches whatever entries are "loading" for the current period.
 */

import { ReactNode, createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";

import { CompanyProfile, FinancialsResponse, PeriodType, fetchFinancials, fetchProfile, needsApiKey } from "@/lib/api";
import { normalizeTicker } from "@/lib/portfolioStore";

export const MAX_COMPARE = 3;
const ANNUAL_HISTORY = 12;
// Ten years of 10-Qs (three a year; Q4 is filed on the 10-K) plus headroom, for horizontal analysis.
const QUARTERLY_HISTORY = 44;

export interface CompanyEntry {
  /** Stable id for React keys and animation: the identifier the user entered, normalized. */
  id: string;
  status: "loading" | "ready" | "error";
  profile?: CompanyProfile;
  financials?: FinancialsResponse;
  /** Annual history for valuation, even while the matrix shows quarters. */
  annual?: FinancialsResponse;
  error?: string;
  /** The data needs an API key the backend doesn't have — shown as "info unavailable", not as an error. */
  unavailable?: boolean;
}

export interface Notice {
  /** Increments on every notice so a repeated warning (e.g. clicking again while full) re-announces. */
  id: number;
  text: string;
  tone: "info" | "warning";
}

interface State {
  entries: CompanyEntry[];
  focusedId: string | null;
  period: PeriodType;
  notice: Notice | null;
}

function notify(state: State, text: string, tone: Notice["tone"] = "info"): Notice {
  return { id: (state.notice?.id ?? 0) + 1, text, tone };
}

type Action =
  | { type: "add"; input: string }
  | { type: "loaded"; id: string; period: PeriodType; profile: CompanyProfile; financials: FinancialsResponse; annual: FinancialsResponse }
  | { type: "failed"; id: string; period: PeriodType; error: string; unavailable: boolean }
  | { type: "remove"; id: string }
  | { type: "focus"; id: string }
  | { type: "period"; period: PeriodType }
  | { type: "dismissNotice" };

/** Identity of a company across identifiers: its CIK, or the listing symbol when it has none. */
function companyKey(profile: CompanyProfile): string {
  return profile.cik ?? `symbol:${profile.symbol}`;
}

/** Display symbol for an entry: its primary ticker once loaded, else what the user entered. */
export function symbolOf(entry: CompanyEntry): string {
  return entry.profile?.tickers[0] ?? entry.id;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": {
      const id = normalizeTicker(action.input);
      if (!id) return { ...state, notice: notify(state, "Enter a valid ticker (e.g. MSFT) or CIK.", "warning") };
      const existing = state.entries.find((e) => e.id === id || e.profile?.tickers.includes(id));
      if (existing) return { ...state, focusedId: existing.id, notice: null };
      if (state.entries.length >= MAX_COMPARE) {
        // Rejected without touching entries, so no column (or shared-layout pill) starts animating.
        return {
          ...state,
          notice: notify(state, `Comparison matrix is full (${MAX_COMPARE}/${MAX_COMPARE}). Remove a column to add ${id}.`, "warning"),
        };
      }
      return { ...state, entries: [...state.entries, { id, status: "loading" }], focusedId: id, notice: null };
    }
    case "loaded": {
      const entry = state.entries.find((e) => e.id === action.id);
      // Ignore responses for removed columns or a period the user has since switched away from.
      if (!entry || action.period !== state.period) return state;
      // Two identifiers can name one company (AAPL and CIK 320193, ASML and ASML.AS): keep the earlier column.
      const duplicate = state.entries.find((e) => e.id !== action.id && e.profile && companyKey(e.profile) === companyKey(action.profile));
      if (duplicate) {
        return {
          ...state,
          entries: state.entries.filter((e) => e.id !== action.id),
          focusedId: duplicate.id,
          notice: notify(state, `${symbolOf(duplicate)} is already in the comparison.`),
        };
      }
      const { profile, financials, annual } = action;
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id ? { ...e, status: "ready", profile, financials, annual, error: undefined } : e,
        ),
      };
    }
    case "failed":
      if (action.period !== state.period) return state;
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id ? { ...e, status: "error", error: action.error, unavailable: action.unavailable } : e,
        ),
      };
    case "remove": {
      const entries = state.entries.filter((e) => e.id !== action.id);
      const focusedId = state.focusedId === action.id ? (entries[entries.length - 1]?.id ?? null) : state.focusedId;
      return { ...state, entries, focusedId, notice: null };
    }
    case "focus":
      return { ...state, focusedId: action.id };
    case "period":
      if (action.period === state.period) return state;
      return { ...state, period: action.period, entries: state.entries.map((e) => ({ ...e, status: "loading" })) };
    case "dismissNotice":
      return { ...state, notice: null };
  }
}

function init(initial: string[]): State {
  return initial.reduce<State>((s, input) => reducer(s, { type: "add", input }), {
    entries: [],
    focusedId: null,
    period: "annual",
    notice: null,
  });
}

interface ComparisonApi extends State {
  focused: CompanyEntry | null;
  isLoading: boolean;
  /** Appends a company column, or focuses it if it's already being compared. */
  add: (input: string) => void;
  remove: (id: string) => void;
  focus: (id: string) => void;
  setPeriod: (period: PeriodType) => void;
  dismissNotice: () => void;
}

const ComparisonContext = createContext<ComparisonApi | null>(null);

export function ComparisonProvider({ initial, children }: { initial: string[]; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, init);
  // `${id}:${period}` of every request already started, so each column/period is fetched once.
  const started = useRef(new Set<string>());

  useEffect(() => {
    for (const entry of state.entries) {
      const key = `${entry.id}:${state.period}`;
      if (entry.status !== "loading" || started.current.has(key)) continue;
      started.current.add(key);
      const { id } = entry;
      const period = state.period;
      // Annual history covers 12 fiscal years, so 10-year growth rates and horizontal analysis are computable.
      Promise.all([
        fetchProfile(id),
        fetchFinancials(id, period, period === "annual" ? ANNUAL_HISTORY : QUARTERLY_HISTORY),
        period === "annual" ? null : fetchFinancials(id, "annual", ANNUAL_HISTORY),
      ])
        .then(([profile, financials, annual]) =>
          dispatch({ type: "loaded", id, period, profile, financials, annual: annual ?? financials }),
        )
        .catch((e) =>
          dispatch({ type: "failed", id, period, error: e instanceof Error ? e.message : "Request failed", unavailable: needsApiKey(e) }),
        )
        // Allow a later re-add or period round-trip to fetch fresh data.
        .finally(() => started.current.delete(key));
    }
  }, [state.entries, state.period]);

  // Stable action identities, so effects that depend on them (e.g. toast auto-dismiss) don't reset.
  const actions = useMemo(
    () => ({
      add: (input: string) => dispatch({ type: "add", input }),
      remove: (id: string) => dispatch({ type: "remove", id }),
      focus: (id: string) => dispatch({ type: "focus", id }),
      setPeriod: (period: PeriodType) => dispatch({ type: "period", period }),
      dismissNotice: () => dispatch({ type: "dismissNotice" }),
    }),
    [],
  );

  const api = useMemo<ComparisonApi>(
    () => ({
      ...state,
      ...actions,
      focused: state.entries.find((e) => e.id === state.focusedId) ?? null,
      isLoading: state.entries.some((e) => e.status === "loading"),
    }),
    [state, actions],
  );

  return <ComparisonContext.Provider value={api}>{children}</ComparisonContext.Provider>;
}

export function useComparison(): ComparisonApi {
  const ctx = useContext(ComparisonContext);
  if (!ctx) throw new Error("useComparison must be used inside <ComparisonProvider>");
  return ctx;
}
