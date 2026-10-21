/**
 * Smooth chart lines: monotone cubic interpolation (the same as d3's curveMonotoneX). Curves pass through
 * every point and never overshoot between them, so a smooth line can't invent a peak the data doesn't have.
 * Points with a null y break the line into separate runs.
 */

export type Pt = [x: number, y: number];

const sign = (v: number) => (v < 0 ? -1 : 1);

/** Tangent at an interior point (Steffen-style limiter, as in d3-shape). */
function slope3(p0: Pt, p1: Pt, p2: Pt): number {
  const h0 = p1[0] - p0[0];
  const h1 = p2[0] - p1[0];
  const s0 = (p1[1] - p0[1]) / (h0 || (h1 < 0 ? -0 : 0) || 1e-12);
  const s1 = (p2[1] - p1[1]) / (h1 || (h0 < 0 ? -0 : 0) || 1e-12);
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/** Tangent at an end point, from the neighbouring tangent. */
function slope2(p0: Pt, p1: Pt, t: number): number {
  const h = p1[0] - p0[0];
  return h ? ((3 * (p1[1] - p0[1])) / h - t) / 2 : t;
}

/** SVG path data for one run of points. */
function run(pts: Pt[]): string {
  const f = (v: number) => v.toFixed(2);
  if (pts.length === 1) return `M${f(pts[0][0])},${f(pts[0][1])}`;
  if (pts.length === 2) return `M${f(pts[0][0])},${f(pts[0][1])}L${f(pts[1][0])},${f(pts[1][1])}`;
  const n = pts.length;
  const t: number[] = new Array(n);
  for (let i = 1; i < n - 1; i++) t[i] = slope3(pts[i - 1], pts[i], pts[i + 1]);
  t[0] = slope2(pts[0], pts[1], t[1]);
  t[n - 1] = slope2(pts[n - 1], pts[n - 2], t[n - 2]);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    d += `C${f(x0 + dx)},${f(y0 + dx * t[i])},${f(x1 - dx)},${f(y1 - dx * t[i + 1])},${f(x1)},${f(y1)}`;
  }
  return d;
}

/** Split into runs of consecutive non-null points. */
export function runs(points: (Pt | null)[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of points) {
    if (p) cur.push(p);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Smooth line through the points (gaps where a point is null). */
export function smoothLine(points: (Pt | null)[]): string {
  return runs(points).map(run).join("");
}

/** Closed area under a smooth line, down to `baseY` — for soft area fills. */
export function smoothArea(points: (Pt | null)[], baseY: number): string {
  return runs(points)
    .filter((r) => r.length > 1)
    .map((r) => `${run(r)}L${r[r.length - 1][0].toFixed(2)},${baseY.toFixed(2)}L${r[0][0].toFixed(2)},${baseY.toFixed(2)}Z`)
    .join("");
}
