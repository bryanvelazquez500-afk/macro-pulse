import type { Variance } from "@/lib/api";

/**
 * Tiered variance badges, mirrored by direction.
 *
 *   tier  |YoY|        drop (down)            surge (up)
 *   1     10–19.9%     muted amber            muted emerald
 *   2     20–29.9%     orange                 emerald
 *   3     30–39.9%     soft crimson           deep emerald
 *   4     ≥ 40%        vivid crimson + alert  vivid emerald + alert
 *
 * Tiers come from the backend (`severity_tier`); this file only maps them to color.
 */

export type Tier = 1 | 2 | 3 | 4;

export const TIER_LABELS: Record<Tier, { range: string; name: string }> = {
  1: { range: "10–19.9%", name: "Material" },
  2: { range: "20–29.9%", name: "Elevated" },
  3: { range: "30–39.9%", name: "High" },
  4: { range: "≥ 40%", name: "Severe" },
};

const DOWN: Record<Tier, string> = {
  1: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25",
  2: "bg-orange-50 text-orange-700 ring-orange-300 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/30",
  3: "bg-rose-50 text-rose-700 ring-rose-300 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/35",
  4: "bg-red-600 text-white ring-red-600 dark:bg-red-600 dark:ring-red-500", // white on red-600: 4.8:1
};

const UP: Record<Tier, string> = {
  1: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  2: "bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-400/20 dark:text-emerald-200 dark:ring-emerald-400/35",
  3: "bg-emerald-200 text-emerald-900 ring-emerald-400 dark:bg-emerald-400/30 dark:text-emerald-100 dark:ring-emerald-400/50",
  4: "bg-emerald-700 text-white ring-emerald-700 dark:bg-emerald-700 dark:ring-emerald-500", // white on emerald-700: 5.5:1
};

export function tierOf(v: Variance | undefined): Tier | null {
  return v?.flagged && v.severity_tier ? (Math.min(4, Math.max(1, v.severity_tier)) as Tier) : null;
}

export function badgeClass(direction: "up" | "down", tier: Tier): string {
  return (direction === "up" ? UP : DOWN)[tier];
}
