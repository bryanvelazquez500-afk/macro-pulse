"use client";

/**
 * Valuation slider state shared between the Valuation panel and the
 * Intrinsic Valuation Station, so moving Revenue Growth or Operating Margin re-prices both at once.
 * Kept per company: switching focus and back restores that company's slider positions.
 */

import { ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

import type { Assumptions } from "@/lib/valuation";

interface Store {
  byCompany: Record<string, Assumptions>;
  set: (companyId: string, a: Assumptions) => void;
}

const Ctx = createContext<Store | null>(null);

export function ValuationAssumptionsProvider({ children }: { children: ReactNode }) {
  const [byCompany, setByCompany] = useState<Record<string, Assumptions>>({});
  const set = useCallback((companyId: string, a: Assumptions) => setByCompany((m) => ({ ...m, [companyId]: a })), []);
  const value = useMemo(() => ({ byCompany, set }), [byCompany, set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** [current assumptions (the company's defaults until a slider moves), setter]. */
export function useAssumptions(companyId: string | null, defaults: Assumptions | null): [Assumptions | null, (a: Assumptions) => void] {
  const store = useContext(Ctx);
  if (!store) throw new Error("useAssumptions must be used inside <ValuationAssumptionsProvider>");
  const current = (companyId && store.byCompany[companyId]) || defaults;
  const set = useCallback((a: Assumptions) => companyId && store.set(companyId, a), [companyId, store]);
  return [current, set];
}
