import type { Variance } from "@/lib/api";

/**
 * Tiered variance badges, mirrored by direction.
 *
 *   tier  |YoY|        drop (down)   surge (up)
 *   1     10–19.9%     --drop-1      --surge-1
 *   2     20–29.9%     --drop-2      --surge-2
 *   3     30–39.9%     --drop-3      --surge-3
 *   4     ≥ 40%        --drop-4      --surge-4
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

// Four heat steps each way (ledger tokens, so both themes follow). Ink text on steps 1–3; step 4 uses its
// own on-color. Direction is never color alone: badges always carry ▲/▼.
const DOWN: Record<Tier, string> = {
  1: "bg-drop-1 text-ink ring-drop-2",
  2: "bg-drop-2 text-ink ring-drop-3/60",
  3: "bg-drop-3 text-ink ring-drop-3",
  4: "bg-drop-4 text-on-drop-4 ring-drop-4",
};

const UP: Record<Tier, string> = {
  1: "bg-surge-1 text-ink ring-surge-2",
  2: "bg-surge-2 text-ink ring-surge-3/60",
  3: "bg-surge-3 text-ink ring-surge-3",
  4: "bg-surge-4 text-on-surge-4 ring-surge-4",
};

export function tierOf(v: Variance | undefined): Tier | null {
  return v?.flagged && v.severity_tier ? (Math.min(4, Math.max(1, v.severity_tier)) as Tier) : null;
}

export function badgeClass(direction: "up" | "down", tier: Tier): string {
  return (direction === "up" ? UP : DOWN)[tier];
}
