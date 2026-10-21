import assert from "node:assert/strict";
import { test } from "node:test";

import { runs, smoothArea, smoothLine } from "./smoothPath.ts";

test("passes through every point and uses cubic segments", () => {
  const d = smoothLine([[0, 0], [10, 10], [20, 5], [30, 20]]);
  assert.match(d, /^M0\.00,0\.00C/);
  for (const p of ["10.00,10.00", "20.00,5.00", "30.00,20.00"]) assert.ok(d.includes(p), p);
  assert.equal((d.match(/C/g) ?? []).length, 3);
});

test("monotone data never overshoots: control points stay within each segment's range", () => {
  const pts: [number, number][] = [[0, 0], [10, 1], [20, 9], [30, 10]];
  const nums = smoothLine(pts).replace(/^M[^C]+/, "").split("C").filter(Boolean).map((seg) => seg.split(",").map(Number));
  nums.forEach((s, i) => {
    const [lo, hi] = [pts[i][1], pts[i + 1][1]];
    for (const y of [s[1], s[3]]) assert.ok(y >= lo - 1e-9 && y <= hi + 1e-9, `segment ${i}: ${y} outside ${lo}..${hi}`);
  });
});

test("nulls split the line into runs; areas close to the baseline", () => {
  assert.equal(runs([[0, 1], null, [2, 3], [3, 4]]).length, 2);
  assert.equal((smoothLine([[0, 1], [1, 2], null, [3, 3], [4, 4]]).match(/M/g) ?? []).length, 2);
  assert.match(smoothArea([[0, 1], [1, 2], [2, 1]], 50), /L2\.00,50\.00L0\.00,50\.00Z$/);
});
