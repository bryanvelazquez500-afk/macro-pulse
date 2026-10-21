const symbols = new Map<string, string>();

/** "$", "€", "£", "¥" — or the ISO code for currencies without a distinct symbol ("CHF "). */
export function currencySymbol(currency: string): string {
  let symbol = symbols.get(currency);
  if (symbol === undefined) {
    try {
      symbol =
        new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
          .formatToParts(0)
          .find((p) => p.type === "currency")?.value ?? currency;
    } catch {
      symbol = currency; // not a valid ISO 4217 code
    }
    if (symbol.length > 1) symbol = `${symbol} `;
    symbols.set(currency, symbol);
  }
  return symbol;
}

/** Compact money in the company's reporting currency: €32.67B, ¥48.04T, CHF 1.2B. */
export function formatMoney(value: number | null | undefined, currency = "USD"): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const sym = currencySymbol(currency);
  if (abs >= 1e12) return `${sign}${sym}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(1)}M`;
  return `${sign}${sym}${abs.toLocaleString()}`;
}

export function formatUsd(value: number | null | undefined): string {
  return formatMoney(value, "USD");
}

export function formatShares(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B sh`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M sh`;
  return `${value.toLocaleString()} sh`;
}

export function formatRatio(value: number, unit: "x" | "%"): string {
  return unit === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(2)}×`;
}

export function formatChange(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`;
}

export function periodLabel(p: { fiscal_year: number | null; fiscal_period: string | null; end: string }): string {
  if (p.fiscal_year == null) return p.end;
  return p.fiscal_period && p.fiscal_period !== "FY" ? `${p.fiscal_period} FY${p.fiscal_year}` : `FY${p.fiscal_year}`;
}

/**
 * Accounting display for money: negatives in parentheses, ($14.26B) instead of -$14.26B. Display only:
 * the underlying number is unchanged. Percent changes keep their ▲/▼ signs instead.
 */
export function formatAccounting(value: number | null | undefined, currency = "USD"): string {
  if (value == null) return "—";
  return value < 0 ? `(${formatMoney(-value, currency)})` : formatMoney(value, currency);
}
