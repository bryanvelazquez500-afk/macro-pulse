/**
 * Watchlist & holdings persisted to localStorage.
 *
 * localStorage is plain text readable by any script on this origin, so only
 * non-sensitive data (tickers, share counts, cost basis) is stored, and everything read back is
 * treated as untrusted: parsed defensively, validated field by field,
 * de-duplicated and size-capped. Anything malformed is dropped rather than rendered.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "investment-station:portfolio:v1";
const MAX_ITEMS = 50;
// Ticker symbols (BRK-B, BF.B) or a numeric CIK.
// US tickers (BRK.B), international listings (ASML.AS, NOVO-B.CO, 7203.T, 0700.HK) and CIKs.
const TICKER_PATTERN = /^(?:[A-Z][A-Z0-9.&-]{0,15}|\d{1,10}|\d{1,6}\.[A-Z]{1,2})$/;

export interface Holding {
  ticker: string;
  shares: number;
  costBasis: number | null; // average cost per share
}

export interface Portfolio {
  watchlist: string[];
  holdings: Holding[];
}

const EMPTY: Portfolio = Object.freeze({ watchlist: [], holdings: [] }) as Portfolio;

export function normalizeTicker(input: string): string | null {
  const ticker = input.trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

const isFinitePositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e12;

function sanitize(raw: unknown): Portfolio {
  if (!raw || typeof raw !== "object") return EMPTY;
  const { watchlist, holdings } = raw as Record<string, unknown>;

  const tickers = new Set<string>();
  for (const t of Array.isArray(watchlist) ? watchlist : []) {
    const ticker = typeof t === "string" ? normalizeTicker(t) : null;
    if (ticker) tickers.add(ticker);
  }

  const positions = new Map<string, Holding>();
  for (const h of Array.isArray(holdings) ? holdings : []) {
    if (!h || typeof h !== "object") continue;
    const { ticker, shares, costBasis } = h as Record<string, unknown>;
    const t = typeof ticker === "string" ? normalizeTicker(ticker) : null;
    if (!t || !isFinitePositive(shares) || positions.has(t)) continue;
    positions.set(t, { ticker: t, shares, costBasis: isFinitePositive(costBasis) ? costBasis : null });
  }

  return { watchlist: [...tickers].slice(0, MAX_ITEMS), holdings: [...positions.values()].slice(0, MAX_ITEMS) };
}

// --- external store -------------------------------------------------------

const listeners = new Set<() => void>();
// Used when storage is unavailable (private mode, blocked cookies) so the UI still works for the session.
let memoryRaw: string | null = null;
let cached: { raw: string | null; value: Portfolio } = { raw: null, value: EMPTY };

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function getSnapshot(): Portfolio {
  const raw = readRaw();
  if (raw !== cached.raw) {
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    cached = { raw, value: sanitize(parsed) };
  }
  return cached.value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep multiple open tabs in sync.
  const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(next: Portfolio) {
  const raw = JSON.stringify(sanitize(next));
  memoryRaw = raw;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Quota exceeded or storage blocked: fall back to in-memory for this session.
  }
  listeners.forEach((l) => l());
}

export function usePortfolio() {
  const portfolio = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);

  return {
    portfolio,
    addToWatchlist(input: string) {
      const ticker = normalizeTicker(input);
      if (!ticker || portfolio.watchlist.includes(ticker)) return false;
      write({ ...portfolio, watchlist: [...portfolio.watchlist, ticker] });
      return true;
    },
    removeFromWatchlist(ticker: string) {
      write({ ...portfolio, watchlist: portfolio.watchlist.filter((t) => t !== ticker) });
    },
    upsertHolding(input: { ticker: string; shares: number; costBasis: number | null }) {
      const ticker = normalizeTicker(input.ticker);
      if (!ticker || !isFinitePositive(input.shares)) return false;
      const holding: Holding = { ticker, shares: input.shares, costBasis: isFinitePositive(input.costBasis) ? input.costBasis : null };
      const others = portfolio.holdings.filter((h) => h.ticker !== ticker);
      write({ ...portfolio, holdings: [...others, holding] });
      return true;
    },
    removeHolding(ticker: string) {
      write({ ...portfolio, holdings: portfolio.holdings.filter((h) => h.ticker !== ticker) });
    },
  };
}
