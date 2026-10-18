/**
 * Saved DCF scenarios ("Saved Fair Values"), persisted to localStorage the same way as the watchlist
 * (portfolioStore.ts): read back defensively, validated field by field and size-capped.
 */

import { useSyncExternalStore } from "react";

import { normalizeTicker } from "@/lib/portfolioStore";

const STORAGE_KEY = "macropulse:dcf-saved:v1";
const MAX_ITEMS = 40;
const BASES = new Set(["eps", "fcf", "dividend"]);

export interface SavedDcf {
  id: string;
  ticker: string;
  basis: "eps" | "fcf" | "dividend";
  d: number; // percent
  g1: number; // percent
  g2: number; // percent
  fairValue: number;
  mos: number | null; // decimal
  currency: string;
  savedAt: string; // ISO timestamp
}

const EMPTY: SavedDcf[] = Object.freeze([]) as unknown as SavedDcf[];
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e12;

function sanitize(raw: unknown): SavedDcf[] {
  if (!Array.isArray(raw)) return EMPTY;
  const out: SavedDcf[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const ticker = typeof e.ticker === "string" ? normalizeTicker(e.ticker) : null;
    if (!ticker || typeof e.id !== "string" || !BASES.has(e.basis as string)) continue;
    if (!num(e.d) || !num(e.g1) || !num(e.g2) || !num(e.fairValue)) continue;
    const currency = typeof e.currency === "string" && /^[A-Z]{3}$/.test(e.currency) ? e.currency : "USD";
    out.push({
      id: e.id.slice(0, 40),
      ticker,
      basis: e.basis as SavedDcf["basis"],
      d: e.d,
      g1: e.g1,
      g2: e.g2,
      fairValue: e.fairValue,
      mos: num(e.mos) ? e.mos : null,
      currency,
      savedAt: typeof e.savedAt === "string" ? e.savedAt.slice(0, 40) : "",
    });
  }
  return out.slice(0, MAX_ITEMS);
}

const listeners = new Set<() => void>();
let memoryRaw: string | null = null;
let cached: { raw: string | null; value: SavedDcf[] } = { raw: null, value: EMPTY };

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function getSnapshot(): SavedDcf[] {
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
  const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(next: SavedDcf[]) {
  const raw = JSON.stringify(sanitize(next));
  memoryRaw = raw;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage blocked or full: keep it in memory for this session.
  }
  listeners.forEach((l) => l());
}

export function useSavedDcfs() {
  const saved = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  return {
    saved,
    save(entry: Omit<SavedDcf, "id" | "savedAt">) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      write([{ ...entry, id, savedAt: new Date().toISOString() }, ...saved]);
    },
    remove(id: string) {
      write(saved.filter((s) => s.id !== id));
    },
  };
}
