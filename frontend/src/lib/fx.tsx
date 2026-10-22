"use client";

/**
 * Show foreign filers' figures in US dollars. Every money line item is multiplied by today's live rate
 * (Yahoo FX, refreshed every 10 minutes); share counts, ratios and forensic scores are untouched. Because
 * every period uses the same rate, year-over-year changes and growth rates are identical in both views —
 * conversion changes the unit, not the story. Display only: valuation keeps the reported currency.
 */

import { Dispatch, ReactNode, SetStateAction, createContext, useContext, useEffect, useMemo, useState } from "react";

import { FinancialPeriod, FinancialsResponse, FxRate, fetchFxRate } from "@/lib/api";
import type { CompanyEntry } from "@/lib/comparisonStore";

const NON_MONEY = new Set(["diluted_shares"]);

type Rates = Record<string, FxRate | null>;

interface FxApi {
  usd: boolean;
  setUsd: (on: boolean) => void;
  rates: Rates;
  setRates: Dispatch<SetStateAction<Rates>>;
}

const FxContext = createContext<FxApi | null>(null);

export function FxProvider({ children }: { children: ReactNode }) {
  const [usd, setUsd] = useState(true); // USD by default: the comparison reads in one currency
  const [rates, setRates] = useState<Rates>({});
  const value = useMemo(() => ({ usd, setUsd, rates, setRates }), [usd, rates]);
  return <FxContext.Provider value={value}>{children}</FxContext.Provider>;
}

function useFx(): FxApi {
  const ctx = useContext(FxContext);
  if (!ctx) throw new Error("useFx outside FxProvider");
  return ctx;
}

function convertPeriod(p: FinancialPeriod, k: number): FinancialPeriod {
  const line_items = Object.fromEntries(
    Object.entries(p.line_items).map(([key, item]) => [key, item && !NON_MONEY.has(key) ? { ...item, value: item.value * k } : item]),
  ) as FinancialPeriod["line_items"];
  const variances = Object.fromEntries(
    Object.entries(p.variances).map(([key, v]) => [key, v && !NON_MONEY.has(key) ? { ...v, prior_value: v.prior_value * k } : v]),
  ) as FinancialPeriod["variances"];
  return { ...p, line_items, variances };
}

function convert(f: FinancialsResponse | undefined, k: number): FinancialsResponse | undefined {
  return f && { ...f, currency: "USD", converted_from: f.currency, periods: f.periods.map((p) => convertPeriod(p, k)) };
}

export interface FxNote {
  currency: string;
  rate: FxRate | null; // null while loading or when no live rate exists
}

/**
 * The comparison's entries as they should be displayed: converted to USD when the switch is on and a live
 * rate is available, otherwise as reported. Also returns which foreign currencies are involved.
 */
export function useDisplayEntries(entries: CompanyEntry[]): { entries: CompanyEntry[]; foreign: FxNote[]; usd: boolean; setUsd: (on: boolean) => void } {
  const { usd, setUsd, rates, setRates } = useFx();
  const currencies = useMemo(
    () => [...new Set(entries.flatMap((e) => (e.financials && e.financials.currency !== "USD" ? [e.financials.currency] : [])))].sort(),
    [entries],
  );

  useEffect(() => {
    for (const cur of currencies) {
      if (cur in rates) continue;
      setRates((r) => ({ ...r, [cur]: null }));
      fetchFxRate(cur).then(
        (rate) => setRates((r) => ({ ...r, [cur]: rate })),
        () => setRates((r) => ({ ...r, [cur]: null })),
      );
    }
  }, [currencies, rates, setRates]);

  const converted = useMemo(
    () =>
      entries.map((e) => {
        const cur = e.financials?.currency;
        const rate = cur && cur !== "USD" ? rates[cur] : null;
        if (!usd || !rate) return e;
        return { ...e, financials: convert(e.financials, rate.usd_per_unit) };
      }),
    [entries, rates, usd],
  );
  return { entries: converted, foreign: currencies.map((c) => ({ currency: c, rate: rates[c] ?? null })), usd, setUsd };
}
