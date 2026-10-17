/**
 * Company-specific readings of each audit ratio, generated from the company's own statements.
 *
 * Every sentence is computed from reported numbers (the ratio's inputs, the same period a year
 * earlier, and the other companies in the matrix) plus qualitative industry context from the
 * company's peer group. No sentence asserts a fact the statements don't show — when inputs are
 * missing, the sentence is skipped. The static `RATIO_LESSONS` teach how to compute and read each
 * ratio from the statements themselves.
 */

import type { FinancialPeriod, RatioKey } from "@/lib/api";
import { formatMoney } from "@/lib/format";

export interface RatioLesson {
  formula: string;
  where: string;
  readWith: string;
}

export const RATIO_LESSONS: Record<RatioKey, RatioLesson> = {
  current_ratio: {
    formula: "Total current assets ÷ total current liabilities",
    where: "Balance sheet — both subtotals sit right above the long-term sections.",
    readWith:
      "Above 1× means what's due within a year is covered by what converts to cash within a year. Read it with the quick ratio and operating cash flow.",
  },
  quick_ratio: {
    formula: "(Cash + short-term investments + receivables) ÷ current liabilities",
    where: "Balance sheet — current assets, excluding inventory and prepaid items.",
    readWith: "The gap to the current ratio is how much liquidity depends on selling inventory.",
  },
  debt_to_equity: {
    formula: "Total liabilities ÷ stockholders' equity",
    where: "Balance sheet — total liabilities (or total liabilities & equity − equity).",
    readWith: "Check whether a high ratio comes from borrowing (long-term debt) or from a shrinking equity base (buybacks, losses).",
  },
  gross_margin_pct: {
    formula: "(Revenue − cost of goods sold) ÷ revenue",
    where: "Income statement — the first two lines.",
    readWith: "Pricing power and production cost. Compare within an industry: software and retail live in different worlds.",
  },
  operating_margin_pct: {
    formula: "Operating income ÷ revenue",
    where: "Income statement — after R&D and SG&A, before interest and tax.",
    readWith: "The gap from gross margin is the cost of running the business. Watch it move with revenue (operating leverage).",
  },
  net_margin_pct: {
    formula: "Net income ÷ revenue",
    where: "Income statement — the bottom line.",
    readWith: "The step down from operating margin is interest, tax and one-offs. A net margin above operating margin needs explaining.",
  },
  asset_turnover: {
    formula: "Revenue ÷ average total assets",
    where: "Income statement revenue over the average of this and last year's balance-sheet total assets.",
    readWith: "Efficiency of the asset base. Net margin × turnover = return on assets (the DuPont link).",
  },
};

// ---------------------------------------------------------------- context

export interface RatioInsightContext {
  symbol: string;
  currency: string;
  peerGroup: string | null; // peers.PEER_GROUPS key
  peerGroupLabel: string | null;
  period: FinancialPeriod;
  prior: FinancialPeriod | null; // same period one year earlier
  /** The same ratio for the other companies in the matrix. */
  others: { symbol: string; value: number; peerGroup: string | null }[];
}

/** Same fiscal period one year earlier: ends 330–400 days before and spans a similar length. */
export function findPriorYear(period: FinancialPeriod, periods: FinancialPeriod[]): FinancialPeriod | null {
  const end = Date.parse(period.end);
  const span = end - Date.parse(period.start);
  const day = 86_400_000;
  return (
    periods.find((p) => {
      const gap = (end - Date.parse(p.end)) / day;
      return gap >= 330 && gap <= 400 && Math.abs(Date.parse(p.end) - Date.parse(p.start) - span) <= 15 * day;
    }) ?? null
  );
}

type Key = keyof FinancialPeriod["line_items"];
const v = (p: FinancialPeriod | null | undefined, k: Key) => p?.line_items[k]?.value ?? null;
const r = (p: FinancialPeriod | null | undefined, k: RatioKey) => p?.ratios[k]?.value ?? null;
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const x2 = (x: number) => `${x.toFixed(2)}×`;
const pp = (x: number) => `${Math.abs(x).toFixed(1)} pp`;

function peers(ctx: RatioInsightContext, value: number, fmt: (n: number) => string, higherIsBetter?: boolean): string | null {
  if (ctx.others.length === 0) return null;
  const all = [...ctx.others, { symbol: ctx.symbol, value }].sort((a, b) => b.value - a.value);
  const rank = all.findIndex((o) => o.symbol === ctx.symbol);
  const list = ctx.others.map((o) => `${o.symbol} ${fmt(o.value)}`).join(", ");
  const position = rank === 0 ? "the highest" : rank === all.length - 1 ? "the lowest" : "in the middle";
  // "Strongest"/"weakest" only within one industry: a retailer's turnover isn't a fair bar for a tech company.
  const sameIndustry = ctx.peerGroup != null && ctx.others.every((o) => o.peerGroup === ctx.peerGroup);
  if (!sameIndustry && higherIsBetter != null) {
    return `${position[0].toUpperCase()}${position.slice(1)} of the companies compared (${list}) — different industries, so read the gap through their business models.`;
  }
  const judgement =
    higherIsBetter == null || all.length < 2 || position === "in the middle"
      ? ""
      : (rank === 0) === higherIsBetter
        ? " — the strongest reading here"
        : " — the weakest reading here";
  return `${position[0].toUpperCase()}${position.slice(1)} of the companies compared (${list})${judgement}.`;
}

function trend(
  ctx: RatioInsightContext,
  key: RatioKey,
  now: number,
  fmt: (n: number) => string,
  threshold: number,
  meaning?: [string, string],
) {
  const before = r(ctx.prior, key);
  if (before == null) return null;
  const delta = now - before;
  const year = ctx.prior?.fiscal_year ? `FY${ctx.prior.fiscal_year}` : "a year earlier";
  if (Math.abs(delta) < threshold) return `Little changed from ${fmt(before)} in ${year}.`;
  const dir = delta > 0 ? "Up" : "Down";
  return `${dir} from ${fmt(before)} in ${year}${meaning ? ` — ${delta > 0 ? meaning[0] : meaning[1]}` : ""}.`;
}

// Industry context by peer group (qualitative only — no invented benchmarks).
const HIGH_TURNOVER = new Set(["big_box_retail", "grocery_pharmacy", "ecommerce", "home_improvement", "restaurants", "apparel"]);
const LOW_TURNOVER = new Set(["utilities", "telecom", "reits", "energy", "transport", "media", "oilfield_services"]);
const LOW_GROSS = new Set(["big_box_retail", "grocery_pharmacy", "ecommerce", "autos", "airlines", "energy", "home_improvement"]);
const HIGH_GROSS = new Set([
  "software",
  "internet_platforms",
  "pharma",
  "payments",
  "semiconductors",
  "big_tech",
  "beverages",
  "household_products",
]);
const LEVERED_BY_DESIGN = new Set(["banks", "capital_markets", "utilities", "reits", "telecom"]);

// ---------------------------------------------------------------- insights

export function ratioInsight(key: RatioKey, ctx: RatioInsightContext): string[] {
  const p = ctx.period;
  const value = r(p, key);
  const money = (n: number) => formatMoney(n, ctx.currency);
  const S = ctx.symbol;
  const out: (string | null)[] = [];

  switch (key) {
    case "current_ratio": {
      const ca = v(p, "current_assets"),
        cl = v(p, "current_liabilities");
      if (value == null || ca == null || cl == null)
        return [
          `${S} doesn't report a classified balance sheet (common for banks and insurers), so current vs. long-term can't be separated.`,
        ];
      const band =
        value < 1
          ? "short-term obligations exceed short-term assets"
          : value < 1.5
            ? "a modest cushion"
            : value < 3
              ? "a comfortable cushion"
              : "a very large cushion — often idle cash";
      out.push(`${S} holds ${money(ca)} of current assets against ${money(cl)} of current liabilities — ${x2(value)}: ${band}.`);
      const liquid = (v(p, "cash_and_equivalents") ?? 0) + (v(p, "short_term_investments") ?? 0);
      const inv = v(p, "inventory") ?? 0;
      const ar = v(p, "accounts_receivable") ?? 0;
      if (liquid / ca >= 0.25) {
        out.push(
          `Its cash pile — ${money(liquid)} of cash and short-term investments, ${pct(liquid / ca)} of current assets — would pay ${pct(liquid / cl)} of current liabilities on its own${liquid >= cl ? ", with room to spare" : ""}.`,
        );
      }
      if (inv / ca >= 0.35) {
        out.push(`Inventory is ${pct(inv / ca)} of current assets (${money(inv)}) — the cushion depends on selling goods, so the quick ratio is the stricter test.`);
      } else if (ar / ca >= 0.35) {
        out.push(`Receivables are ${pct(ar / ca)} of current assets (${money(ar)}) — liquidity depends on customers paying on time.`);
      }
      const fcf = v(p, "free_cash_flow");
      if (value < 1 && fcf != null) {
        out.push(
          fcf > 0
            ? `A sub-1× ratio isn't distress when cash keeps arriving: ${S} generated ${money(fcf)} of free cash flow this period (${pct(fcf / cl)} of current liabilities). Businesses that collect from customers before paying suppliers often run this way.`
            : `With negative free cash flow (${money(fcf)}), a sub-1× ratio means the gap must be financed — a genuine liquidity flag.`,
        );
      }
      out.push(trend(ctx, key, value, x2, 0.05, ["more cover for near-term bills", "less cover for near-term bills"]));
      out.push(peers(ctx, value, x2));
      break;
    }

    case "quick_ratio": {
      const cl = v(p, "current_liabilities");
      const cr = r(p, "current_ratio");
      if (value == null || cl == null) return [`Quick-ratio inputs aren't reported for ${S}.`];
      const band =
        value < 0.8
          ? "tight: without selling inventory, liquid assets don't cover near-term bills"
          : value < 1
            ? "close to covering near-term bills from liquid assets alone"
            : "liquid assets alone cover near-term bills";
      out.push(`At ${x2(value)}, ${band}.`);
      const inv = v(p, "inventory");
      if (cr != null) {
        const gap = cr - value;
        // What the gap is worth in money, and how much of it inventory explains.
        const gapAmount = gap * cl;
        const invShare = inv && gapAmount > 0 ? inv / gapAmount : 0;
        if (gap < 0.1) {
          out.push(`Almost no gap to the ${x2(cr)} current ratio: liquidity doesn't hinge on selling stock or on prepaid items.`);
        } else if (invShare >= 0.6) {
          out.push(
            `The ${gap.toFixed(2)}× gap to the ${x2(cr)} current ratio is mostly inventory (${money(inv!)} of the ${money(gapAmount)} difference)${
              HIGH_TURNOVER.has(ctx.peerGroup ?? "") ? ` — normal for ${ctx.peerGroupLabel}, where goods on hand are the business` : ""
            }.`,
          );
        } else {
          out.push(
            `The ${gap.toFixed(2)}× gap to the ${x2(cr)} current ratio (${money(gapAmount)}) is mostly other current assets — prepaid expenses, assets held for sale and the like${
              inv ? `; inventory is only ${money(inv)}` : ""
            }. Those rarely turn into cash quickly, which is why the quick ratio leaves them out.`,
          );
        }
      }
      if (p.ratios.quick_ratio?.note) out.push(`Note: ${p.ratios.quick_ratio.note.toLowerCase()}.`);
      out.push(trend(ctx, key, value, x2, 0.05));
      out.push(peers(ctx, value, x2));
      break;
    }

    case "debt_to_equity": {
      const tl = v(p, "total_liabilities"),
        eq = v(p, "stockholders_equity");
      if (eq != null && eq <= 0) {
        return [
          `${S}'s equity is negative (${money(eq)}): liabilities exceed assets on the books, so debt-to-equity isn't meaningful.`,
          `That usually comes from years of buybacks or dividends exceeding retained profit, or from accumulated losses — check retained earnings to tell which.`,
        ];
      }
      if (value == null || tl == null || eq == null) return [`Liabilities or equity aren't reported for ${S}.`];
      const band =
        value < 0.5
          ? "conservatively financed"
          : value < 1.5
            ? "moderately financed"
            : value < 3
              ? "leaning heavily on liabilities"
              : "highly geared";
      out.push(`${S} carries ${money(tl)} of liabilities against ${money(eq)} of equity (${x2(value)}): ${band}.`);
      const ltd = v(p, "long_term_debt");
      if (ltd != null)
        out.push(
          `Long-term debt is ${money(ltd)}, ${pct(ltd / tl)} of liabilities; the rest is operating obligations such as payables, accruals and deferred revenue.`,
        );
      const eqBefore = v(ctx.prior, "stockholders_equity"),
        ni = v(p, "net_income");
      if (eqBefore != null && ni != null && ni > 0 && eq < eqBefore) {
        out.push(
          `Equity fell from ${money(eqBefore)} to ${money(eq)} despite ${money(ni)} of profit — capital returned through buybacks and dividends shrinks the denominator, so part of this ratio reflects shareholder payouts rather than new borrowing.`,
        );
      }
      if (LEVERED_BY_DESIGN.has(ctx.peerGroup ?? "")) {
        out.push(
          ctx.peerGroup === "banks" || ctx.peerGroup === "capital_markets"
            ? "For a financial firm, customer deposits and funding are liabilities, so high ratios are structural — judge it with regulatory capital, not this ratio."
            : `${ctx.peerGroupLabel} finance long-lived, steady-earning assets with debt, so higher ratios are normal for the sector.`,
        );
      }
      out.push(trend(ctx, key, value, x2, 0.1, ["more reliance on liabilities", "less reliance on liabilities"]));
      out.push(peers(ctx, value, x2, false));
      break;
    }

    case "gross_margin_pct": {
      const rev = v(p, "revenue"),
        cogs = v(p, "cost_of_goods_sold");
      if (value == null || rev == null || cogs == null)
        return [
          `${S} doesn't report cost of goods sold separately (common for banks and some service firms), so gross margin can't be computed.`,
        ];
      out.push(
        `${S} keeps ${value.toFixed(1)}% of each sale after direct costs: ${money(rev - cogs)} of gross profit on ${money(rev)} of revenue.`,
      );
      const before = r(ctx.prior, key);
      if (before != null && Math.abs(value - before) >= 0.5) {
        out.push(
          `${value > before ? "Up" : "Down"} ${pp(value - before)} from ${before.toFixed(1)}% a year earlier — ${value > before ? "pricing power, cheaper inputs or a richer product mix" : "cost pressure, discounting or a shift toward lower-margin products"}.`,
        );
      } else if (before != null) out.push(`Steady versus ${before.toFixed(1)}% a year earlier — a sign of stable pricing.`);
      if (HIGH_GROSS.has(ctx.peerGroup ?? ""))
        out.push(
          `High gross margins are typical of ${ctx.peerGroupLabel}: once a product, brand or formula exists, each extra unit costs little to deliver.`,
        );
      else if (LOW_GROSS.has(ctx.peerGroup ?? ""))
        out.push(
          `Thin gross margins are normal in ${ctx.peerGroupLabel}: the business resells or manufactures physical goods, so profit comes from volume and cost control rather than markup.`,
        );
      out.push(peers(ctx, value, (n) => `${n.toFixed(1)}%`, true));
      break;
    }

    case "operating_margin_pct": {
      const rev = v(p, "revenue"),
        oi = v(p, "operating_income");
      if (value == null || rev == null || oi == null) return [`Operating income isn't reported for ${S}.`];
      out.push(`${value.toFixed(1)}% of revenue survives all operating costs: ${money(oi)} of operating income.`);
      const gm = r(p, "gross_margin_pct");
      const sga = v(p, "sga_expense");
      if (gm != null) {
        out.push(
          `Operating expenses absorb ${pp(gm - value)} of the ${gm.toFixed(1)}% gross margin${sga != null ? `; SG&A alone is ${pct(sga / rev, 1)} of revenue` : ""}.`,
        );
      }
      const revBefore = v(ctx.prior, "revenue"),
        oiBefore = v(ctx.prior, "operating_income");
      if (revBefore && oiBefore && oiBefore > 0) {
        const rg = rev / revBefore - 1,
          og = oi / oiBefore - 1;
        if (rg > 0 && og > rg + 0.02)
          out.push(
            `Revenue grew ${pct(rg, 1)} while operating income grew ${pct(og, 1)} — operating leverage: costs grew slower than sales.`,
          );
        else if (rg > 0 && og < rg - 0.02)
          out.push(`Revenue grew ${pct(rg, 1)} but operating income only ${pct(og, 1)} — costs outpaced sales, so margins compressed.`);
        else if (rg <= 0)
          out.push(`Revenue ${rg < 0 ? `fell ${pct(-rg, 1)}` : "was flat"}; operating income moved ${og >= 0 ? "+" : ""}${pct(og, 1)}.`);
      }
      out.push(peers(ctx, value, (n) => `${n.toFixed(1)}%`, true));
      break;
    }

    case "net_margin_pct": {
      const rev = v(p, "revenue"),
        ni = v(p, "net_income");
      if (value == null || rev == null || ni == null) return [`Net income isn't reported for ${S}.`];
      out.push(`${S} converts ${value.toFixed(1)}% of revenue into profit: ${money(ni)} of net income.`);
      const om = r(p, "operating_margin_pct");
      const pre = v(p, "pretax_income"),
        tax = v(p, "income_tax_expense");
      const taxNote = pre && pre > 0 && tax != null ? ` (effective tax rate ${pct(tax / pre, 1)})` : "";
      if (om != null) {
        out.push(
          value <= om
            ? `The ${pp(om - value)} step down from the ${om.toFixed(1)}% operating margin is interest, tax and other items${taxNote}.`
            : `Net margin is above the ${om.toFixed(1)}% operating margin — non-operating gains (investment income, asset sales, tax benefits) lifted the bottom line; check whether they recur.`,
        );
      }
      out.push(
        trend(ctx, key, value, (n) => `${n.toFixed(1)}%`, 0.5, [
          "more of each sale reaching shareholders",
          "less of each sale reaching shareholders",
        ]),
      );
      out.push(peers(ctx, value, (n) => `${n.toFixed(1)}%`, true));
      break;
    }

    case "asset_turnover": {
      const rev = v(p, "revenue"),
        ta = v(p, "total_assets");
      if (value == null || rev == null || ta == null) return [`Revenue or total assets aren't reported for ${S}.`];
      const quarterly = p.fiscal_period != null && p.fiscal_period !== "FY";
      out.push(
        `${S} generated ${money(rev)} of revenue from a ${money(ta)} asset base: ${x2(value)}${quarterly ? " for the quarter (not annualized — roughly ×4 for a yearly figure)" : " a year"}.`,
      );
      const nm = r(p, "net_margin_pct");
      if (nm != null)
        out.push(
          `With a ${nm.toFixed(1)}% net margin, return on assets is ${((nm / 100) * value * 100).toFixed(1)}% (net margin × turnover — the DuPont link between profitability and efficiency).`,
        );
      if (HIGH_TURNOVER.has(ctx.peerGroup ?? ""))
        out.push(
          `${ctx.peerGroupLabel} depend on turnover: thin margins earned on fast-moving goods, so every rotation of inventory and store assets counts.`,
        );
      else if (LOW_TURNOVER.has(ctx.peerGroup ?? ""))
        out.push(
          `${ctx.peerGroupLabel} are capital-intensive (networks, plants, property), so assets turn slowly and returns rely on margin instead.`,
        );
      out.push(trend(ctx, key, value, x2, 0.03, ["the asset base is working harder", "assets grew faster than sales"]));
      out.push(peers(ctx, value, x2, true));
      break;
    }
  }
  return out.filter((s): s is string => !!s);
}
