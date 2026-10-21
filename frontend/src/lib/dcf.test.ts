// Run with `npm test` (Node's built-in test runner; Node strips the TypeScript types).
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TERMINAL_GROWTH, defaultDiscountRate, defaultGrowthRate, marginOfSafety, projection, reverseDcfGrowth, twoStage } from "./dcf.ts";

const base = { e0: 2.0, d: 0.1, g1: 0.12, n: 10, g2: 0.04, m: 10 };
const price = 40.0;
const r2 = (v: number) => Math.round(v * 100) / 100;

test("TBV off", () => {
  const r = twoStage(base);
  assert.equal(r2(r.growthValue), 22.11);
  assert.equal(r2(r.terminalValue), 17.82);
  assert.equal(r2(r.fairValue), 39.93);
  assert.equal(r2(marginOfSafety(r.fairValue, price)! * 100), -0.17);
  assert.equal(r2(reverseDcfGrowth(base, price)! * 100), 12.02);
});

test("TBV on with TBV = 5.00", () => {
  const r = twoStage({ ...base, tbv: 5.0, addTbv: true });
  assert.equal(r2(r.fairValue), 44.93);
  assert.equal(r2(marginOfSafety(r.fairValue, price)! * 100), 10.98);
});

test("default rules", () => {
  assert.equal(r2(defaultDiscountRate(4.2) * 100), 11);
  // Realistic bounds (audit, Oct 2026): growth held to 0–15%, terminal growth 3%.
  assert.equal(r2(defaultGrowthRate(55) * 100), 15);
  assert.equal(r2(defaultGrowthRate(2) * 100), 2);
  assert.equal(r2(defaultGrowthRate(-6) * 100), 0);
  assert.equal(r2(defaultGrowthRate(null) * 100), 0);
  assert.equal(DEFAULT_TERMINAL_GROWTH, 0.03);
});

test("x = 1 and y = 1 don't divide by zero", () => {
  const r = twoStage({ e0: 1, d: 0.04, g1: 0.04, n: 10, g2: 0.04, m: 10 });
  assert.ok(Math.abs(r.growthValue - 10) < 1e-9);
  assert.ok(Math.abs(r.terminalValue - 10) < 1e-9);
});

test("projection present values sum to growth + terminal value", () => {
  const r = twoStage(base);
  const total = projection(base).reduce((s, row) => s + row.presentValue, 0);
  assert.ok(Math.abs(total - (r.growthValue + r.terminalValue)) < 1e-9);
});
