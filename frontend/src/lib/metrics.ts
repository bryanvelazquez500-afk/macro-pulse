import type { BalanceSheetKey, CashFlowKey, IncomeStatementKey, MetricKey, RatioKey } from "@/lib/api";

export const INCOME_STATEMENT_ROWS: { key: IncomeStatementKey; label: string; unit?: "shares" }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "cost_of_goods_sold", label: "Cost of Goods Sold" },
  { key: "operating_income", label: "Operating Income" },
  { key: "net_income", label: "Net Income" },
  { key: "diluted_shares", label: "Diluted Shares", unit: "shares" },
];

export const CASH_FLOW_ROWS: { key: CashFlowKey; label: string }[] = [
  { key: "operating_cash_flow", label: "Operating Cash Flow" },
  { key: "capital_expenditures", label: "Capital Expenditures" },
  { key: "free_cash_flow", label: "Free Cash Flow" },
];

export const BALANCE_SHEET_ROWS: { key: BalanceSheetKey; label: string }[] = [
  { key: "cash_and_equivalents", label: "Cash & Equivalents" },
  { key: "short_term_investments", label: "Short-Term Investments" },
  { key: "accounts_receivable", label: "Accounts Receivable" },
  { key: "inventory", label: "Inventory" },
  { key: "current_assets", label: "Total Current Assets" },
  { key: "total_assets", label: "Total Assets" },
  { key: "current_liabilities", label: "Total Current Liabilities" },
  { key: "total_liabilities", label: "Total Liabilities" },
  { key: "stockholders_equity", label: "Stockholders' Equity" },
  { key: "retained_earnings", label: "Retained Earnings" },
  { key: "long_term_debt", label: "Long-Term Debt" },
];

export const METRIC_LABELS = Object.fromEntries(
  [...INCOME_STATEMENT_ROWS, ...CASH_FLOW_ROWS, ...BALANCE_SHEET_ROWS].map((r) => [r.key, r.label]),
) as Record<MetricKey, string>;

export const RATIO_ROWS: { key: RatioKey; label: string; unit: "x" | "%" }[] = [
  { key: "current_ratio", label: "Current Ratio", unit: "x" },
  { key: "quick_ratio", label: "Quick Ratio", unit: "x" },
  { key: "debt_to_equity", label: "Debt-to-Equity", unit: "x" },
  { key: "gross_margin_pct", label: "Gross Margin %", unit: "%" },
  { key: "operating_margin_pct", label: "Operating Margin %", unit: "%" },
  { key: "net_margin_pct", label: "Net Margin %", unit: "%" },
  { key: "asset_turnover", label: "Asset Turnover", unit: "x" },
];
