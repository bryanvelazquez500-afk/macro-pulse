# Financial Model Core Guardrails

## 1. Business-to-Model Routing Logic

Never apply a uniform financial model. Route businesses strictly by operational type:

- **SaaS / Subscription:** Route to Multi-Period Discounted Cash Flow (DCF) driven by MRR/ARR, Churn, LTV:CAC, and Net Expansion Rate. Never use basic book-value or asset-heavy models (which cause gross undervaluation).
- **Marketplace / High-Growth Platforms:** Model via Gross Merchandise Value (GMV) or Take-Rate margin analysis combined with a forward EV/Revenue or EV/EBITDA multiple.
- **Asset-Heavy / Traditional Retail:** Model via 3-Statement Forecasting (P&L, Balance Sheet, Cash Flow) anchored heavily on CapEx, inventory turns, and Asset-Based Valuation (NAV).
- **Service / Agency:** Model using utilization rates, billable hours scalability, and human capital margins, applying lower relative terminal multiples.

## 2. Anti-Bias & Valuation Integrity Rules

- **Objective Baseline:** Base valuations strictly on observable numbers, verifiable margins, and realistic growth decay metrics.
- **The "No Hype" Rule:** Do not inflate terminal growth rates past long-term GDP averages (typically capped at 2.5% to 3.0%).
- **The "Anti-Undervaluation" Floor:** For early-stage or high-margin IP businesses, explicitly prevent Claude from over-weighting tangible book asset calculations. Account for intangible asset value and customer retention continuity.
- **Terminal Value Quality Check:** If the terminal value or exit multiple calculation represents >75% of the total Enterprise Value, flag this threshold and force a dynamic reality check on near-term growth numbers.
