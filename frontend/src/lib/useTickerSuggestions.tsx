"use client";

/**
 * Ticker suggestions as you type: every US-listed SEC filer plus the scout lists' international listings
 * (/api/universe/search). Debounced, so typing "MICRO" makes one request, not five. Render
 * <TickerSuggestions id=… query=…/> next to an input and give the input `list={id}`.
 */

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/api";

export interface Suggestion {
  ticker: string;
  name: string;
  exchange: string;
  sector: string;
}

export function useTickerSuggestions(query: string, limit = 8): Suggestion[] {
  const [results, setResults] = useState<Suggestion[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${API_URL}/api/universe/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results: Suggestion[] }) => setResults(d.results ?? []))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, limit]);
  return query.trim() ? results : [];
}

export function TickerSuggestions({ id, query }: { id: string; query: string }) {
  const results = useTickerSuggestions(query);
  return (
    <datalist id={id}>
      {results.map((r) => (
        <option key={r.ticker} value={r.ticker}>
          {r.name} · {r.exchange}
        </option>
      ))}
    </datalist>
  );
}
