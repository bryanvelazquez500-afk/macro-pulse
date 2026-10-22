// Shared by the line-item table and the filing-reaction table, so moves are colored the same way.

/** Step thresholds (%): line-item YoY changes use the comparison legend's 10/20/30/40. */
export const YOY_STEPS = [10, 20, 30, 40] as const;
/** Day-scale stock reactions are smaller, so their four steps start lower. */
export const REACTION_STEPS = [2, 5, 8, 12] as const;

/**
 * Heat square for a % change: four steps each way (surge / drop tokens); changes under the first step get
 * a faint tint so every cell still reads at a glance.
 */
export function heat(change: number | null, steps: readonly number[] = YOY_STEPS): { bg: string; step: number } | null {
  if (change == null) return null;
  const a = Math.abs(change);
  const dir = change >= 0 ? "surge" : "drop";
  if (a < steps[0]) return { bg: `color-mix(in srgb, var(--${dir}-1) 55%, transparent)`, step: 0 };
  const step = a >= steps[3] ? 4 : a >= steps[2] ? 3 : a >= steps[1] ? 2 : 1;
  return { bg: `var(--${dir}-${step})`, step };
}
