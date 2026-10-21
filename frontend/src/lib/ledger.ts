/**
 * Ledger rules shared by the comparison matrix and the line-item tables: a single rule above subtotals,
 * a double rule under grand totals (accounting-paper conventions).
 */

export const SUBTOTALS = new Set([
  "gross_profit",
  "operating_income",
  "current_assets",
  "total_assets",
  "current_liabilities",
  "total_liabilities",
  "free_cash_flow",
]);

export const GRAND_TOTALS = new Set(["net_income", "stockholders_equity"]);

/** Row classes for a line item: border rules plus label/value weight. */
export function ledgerRule(key: string): string {
  if (GRAND_TOTALS.has(key)) return "border-b-[3px] border-double !border-b-spruce-strong font-bold";
  if (SUBTOTALS.has(key)) return "border-t border-t-ink-3 font-semibold";
  return "";
}
