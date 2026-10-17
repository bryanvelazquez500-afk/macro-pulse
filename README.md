# MacroPulse

Standardized corporate financials pulled directly from SEC EDGAR.

- `backend/` — FastAPI service (Python)
- `frontend/` — Next.js + React + Tailwind CSS

## Run it

```bash
# Backend  → http://localhost:8000  (docs at /docs)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend → http://localhost:3000
cd frontend
npm install
npm run dev
```

Tests: `cd backend && .venv/bin/python -m pytest`

## Deploy

Two services: the Python API (FastAPI) and the Next.js frontend (Node ≥ 20.9).

```bash
# API: gunicorn managing one async uvicorn worker (config and rationale in backend/gunicorn.conf.py)
cd backend
pip install -r requirements.txt
IS_CORS_ORIGINS=https://app.macropulse.example PORT=8000 gunicorn -c gunicorn.conf.py app.main:app

# Frontend: the API URL is inlined at build time
cd frontend
npm ci
NEXT_PUBLIC_API_URL=https://api.macropulse.example npm run build
npm start
```

| Variable | Service | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | frontend (build time) | API base URL. Unset or empty → `http://localhost:8000` |
| `IS_CORS_ORIGINS` | API | Frontend origin(s) allowed to call the API: comma-separated or a JSON array. Default `localhost:3000` |
| `PORT`, `WEB_CONCURRENCY` | API | Bind port; worker count. **Keep 1 worker** — the SEC rate limiter and the caches are per process |
| `IS_SEC_USER_AGENT` | API | SEC-required "Name email" User-Agent |
| `ANTHROPIC_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY` | API | Optional providers (see `backend/.env.example`) |

## API

| Endpoint | Source | Description |
| --- | --- | --- |
| `GET /api/companies/{ticker_or_cik}` | Submissions | Company profile + recent filings |
| `GET /api/companies/{ticker_or_cik}/financials?period=annual\|quarterly&limit=10&variance_threshold=0.10` | CompanyFacts | Income statement, balance sheet, audit ratios, YoY material variances |

## Global companies: dual data pipeline (`backend/app/services/data_router.py`)

Any endpoint accepts an international listing with an exchange suffix (`ASML.AS`, `VOD.L`, `SAP.DE`,
`7203.T`, `NOVO-B.CO`). US tickers, share classes (`BRK.B`) and CIKs stay on the SEC pipeline.

```
TSLA, BRK.B, 320193 ──────────────────────────► SEC EDGAR (10-K/10-Q, US GAAP, USD)
ASML.AS, VOD.L, 7203.T ─► SEC registrant? ─yes─► SEC EDGAR (20-F/40-F, IFRS or US GAAP, home currency)
                                  └──── no ────► Financial Modeling Prep (standardized statements)
```

1. **Foreign SEC registrants (free).** Many large foreign companies file annual reports with the SEC,
   tagged in IFRS (`ifrs-full`) or US GAAP and reported in their own currency (EUR, GBP, JPY, …).
   `listings.py` maps a home listing to its EDGAR ticker. The mapping is curated where the symbols differ
   (`SAN.PA` → Sanofi `SNY`, `7203.T` → `TM`). Where they match, the EDGAR company must be incorporated or
   based in the exchange's country, so `MC.PA` (LVMH) is never treated as Moelis & Co (`MC`).
   The reporting basis (taxonomy and currency) comes from each company's latest annual report.
   USD "convenience translations" are ignored, and only one currency is used per company.
2. **Financial Modeling Prep, for everything else.** Requires `FMP_API_KEY` in `backend/.env`.
   **FMP's free plan covers US listings only** (plus 5 periods per request and 250 requests a day).
   Non-US statements need a paid FMP plan. Without one, the API returns a clear 402. Without a key, it returns a 503.
   FMP's fields map onto the same internal metrics (`fmp_mapping.py`). Unreported fields, which FMP sends
   as `0`, are treated as missing. Capex signs are normalized, and period start dates are inferred.

Both pipelines produce the same normalized periods, so ratios, variances and the Piotroski, Altman and
Sloan scores work for global companies unchanged. Responses include `source`, `accounting_standard` and
`currency`, and the matrix formats each column in its own currency (€32.67B, ¥48.04T).

| Internal metric | IFRS tags (priority order) | FMP field |
| --- | --- | --- |
| `revenue` | Revenue, RevenueFromContractsWithCustomers, RevenueAndOperatingIncome, RevenueFromSaleOfGoods | revenue |
| `cost_of_goods_sold` | CostOfSales | costOfRevenue |
| `operating_income` | ProfitLossFromOperatingActivities | operatingIncome |
| `net_income` | ProfitLossAttributableToOwnersOfParent, ProfitLoss | bottomLineNetIncome, netIncome |
| `diluted_shares` | AdjustedWeightedAverageShares | weightedAverageShsOutDil |
| `operating_cash_flow` | CashFlowsFromUsedInOperatingActivities | operatingCashFlow |
| `capital_expenditures` | PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities, … | capitalExpenditure (sign flipped) |
| `total_liabilities` | Liabilities, else EquityAndLiabilities − Equity | totalLiabilities, else totalLiabilitiesAndTotalEquity − totalEquity |
| `stockholders_equity` | EquityAttributableToOwnersOfParent, Equity | totalStockholdersEquity, totalEquity |
| `retained_earnings` | RetainedEarnings | retainedEarnings |
| `long_term_debt` | LongtermBorrowings, NoncurrentPortionOfNoncurrentBondsIssued | longTermDebt |

Limitations:
- Foreign filers publish no XBRL quarterlies (6-Ks aren't tagged), so their quarterly view is empty.
- The MD&A narrative needs a 10-K.
- Peer pills need an SEC industry code (SIC), so they don't appear for FMP-only companies.

## Legend Investment Checklist (`backend/app/services/vetting.py`, `GET /api/companies/{id}/checklist`)

The focused company's annual history is scored against four investors' rules. Each investor gets
**Worth Buying** only when every criterion passes. Otherwise the verdict is **Pass**, and a criterion
without enough data counts as not met.

| Investor | Criterion | Rule |
| --- | --- | --- |
| Buffett | ROIC: operating income × (1 − effective tax) ÷ average (equity + long-term debt) | > 15% |
| Buffett | Gross margin stability: max − min over up to 5 years | ≤ 5 pp |
| Lynch | PEG: (price ÷ diluted EPS) ÷ diluted-EPS CAGR % over up to 5 years | < 1.0 |
| Munger | Piotroski F-score | ≥ 7 |
| Munger | Long-term debt ÷ equity | < 0.5 |
| Ackman | Operating leverage: operating-income CAGR ÷ revenue CAGR over 3 years, revenue growing | ≥ 1.25× |
| Ackman | Free cash flow positive in every one of up to 5 years | all |
| Buffett | Capital-light: Σ capex ÷ Σ operating cash flow over up to 5 years | < 50% |
| Buffett | Declining share count: diluted shares vs 5 years ago (split-adjusted) | lower |
| Buffett | Expanding operating margin vs 5 years ago | higher |
| Lynch | Inventory growth − revenue growth, latest year (passes when no inventory is carried) | ≤ 5 pp |
| Lynch | Net cash: cash + short-term investments − long-term debt | > 0 |
| Munger | Gross margin, latest year | > 40% |
| Munger | SG&A ÷ revenue: range over up to 5 years, or falling | ≤ 3 pp, or falling |
| Ackman | FCF yield on EV: FCF ÷ (price × diluted shares + long-term debt − cash − short-term investments) | ≥ 5% |

Each investor's checklist also carries a `context` object (`backend/app/services/legend_context.py`):
- Their tenure and approach.
- A well-documented case study: Buffett and Apple, Lynch and Hanes' L'eggs, Munger and See's Candies,
  Ackman and Chipotle. The `illustrates` field links each case study to the criteria it demonstrates.
- One widely attributed quote, rules of thumb, and further reading.

View B shows this in an expandable "Historical context" section on each card.

SG&A is a new metric. It uses `SellingGeneralAndAdministrativeExpense` (US GAAP or IFRS) or FMP's
`sellingGeneralAndAdministrativeExpenses`. Otherwise it is the sum of a selling line and an administrative
line, as Microsoft, Alphabet and SAP report it. It's left blank when only one of the two is reported.

- **Price** (Lynch only): taken from FMP's profile when `FMP_API_KEY` is set, otherwise from Yahoo Finance's
  public chart endpoint. The Yahoo endpoint is unofficial and may break; a failure just means "no price".
  Quotes in pence (GBp), cents (ZAc) or agorot (ILA) are converted to whole units (GBP, ZAR, ILS).
- **When price isn't used for P/E:**
  - The quote's currency differs from the reporting currency (e.g. VOD.L trades in GBP but reports in EUR).
  - A foreign filer is priced through its US ADR, which can represent several ordinary shares. Use the
    home listing (ASML.AS) instead.
- **Stock splits** are detected from the filings themselves: a period reported with share counts that
  differ by a split-like ratio in two filings. Older diluted share counts are then restated onto today's
  basis, so EPS growth and Piotroski's dilution signal aren't distorted (e.g. NVIDIA's 10-for-1 split in 2024).
- Pre-tax income and income tax are now extracted too (US GAAP, IFRS and FMP), for the effective tax rate.

These are mechanical screens inspired by each investor's published principles. They are not their
actual process, and not investment advice.

## Macro valuation factors (`backend/app/services/macro_rates.py`)

`backend/data/macro_factors.json` holds the active valuation constants:
- **Risk-free rate:** the 10-year Treasury yield, with its date and source.
- **Equity risk premium:** 4.46%, Damodaran's US total ERP, updated January 5, 2026.
- **Baseline betas for every peer group, plus the market:** from Damodaran's January 2026 *Betas by Sector (US)*.
  Groups that span several of his industries use firm-weighted averages, and the source industries are recorded.

`load_macro_factors()` reads the file, caches it in memory until the file changes, and creates it from
defaults if it's missing. `factors.cost_of_equity(group)` gives the CAPM cost of equity.

Refresh the risk-free rate by running the module directly. It never runs on import or app startup:

```bash
cd backend && .venv/bin/python -m app.services.macro_rates
```

It reads the 10-year yield from the U.S. Treasury daily par yield curve CSV and from FRED's DGS10 series.
FRED uses its API if `FRED_API_KEY` is set, otherwise its keyless CSV. The newer observation wins; FRED
usually lags Treasury by a business day. The file is written atomically, and a failed fetch leaves it
untouched. The ERP and betas don't change during a sync, so edit the JSON when new editions are published.

## Layout

| Column | Wide screens (≥1280px) | 1024–1279px |
| --- | --- | --- |
| Left rail, 340px, sticky | Intrinsic Valuation Station (with ⚡ Sync), then the watchlist | same, 300px |
| Center | Comparison matrix / Strategy shell, focused-company valuation | same |
| Right rail, 320px, sticky | Related news, sized to the viewport | moves below the center column |

The header carries **📋 View Data Lineage** (the raw tag map behind every matrix number) and **📅 SEC Filings
History** (recent 10-K/10-Q/8-K/20-F filings with links). Both are overlay drawers for the focused company
(`frontend/src/components/DataDrawers.tsx`). They close with Escape or a click outside. The header's height
is published as `--header-h`, so the sticky rails always sit just below it and fit the viewport.

## Equity Discovery (tab C, `frontend/src/components/EquityDiscovery.tsx`)

A dark, game-style scout map of world markets.
- **World view:** hovering lights up a continent, and clicking it zooms the camera into that region.
- **Region view:** each country is hoverable and clickable. Labels are sized to the zoom and kept from
  colliding, and covered markets carry pulsing markers.
- **Country report:** clicking a country slides in its largest listed companies, **grouped by sector**, with
  jump chips and a sticky sector header. Each row shows the company name, ticker, live price and day change,
  a data-coverage badge, and its **GuruFocus-style DCF value with margin of safety**. → adds the company to the
  comparison matrix.
- **Long lists stay fast:** the list is virtualized (fixed-height rows; only rows near the viewport are mounted).
  A row fetches its DCF (`GET /api/companies/{id}/gurufocus-dcf`) only after it has been inside the viewport
  for 250 ms, with at most 4 requests in flight.
- **DCF on the backend:** `backend/app/services/gurufocus.py` computes the same model as the Station
  (`frontend/src/lib/gurufocusDcf.ts`); a shared test vector keeps the two in step. Results are cached for 6h.
  The SEC CompanyFacts behind them are not cached, since each holds about 17 MB once parsed.
- **Keyboard:** region buttons and a per-region roster give keyboard access, and Escape steps back.

Data and implementation:
- **Geometry:** Natural Earth 1:50m countries (public domain), simplified into
  `frontend/public/geo/world-50m.topo.json` (342 KB, 120 KB gzipped). It loads the first time the tab opens,
  and is drawn with `d3-geo` + `topojson-client`.
- **Stock lists:** `backend/app/services/discovery.py` holds 31 countries and 594 listings, the largest
  companies by market cap as of 2025–26, each tagged with a GICS-style sector. Each symbol was checked against Yahoo Finance when the list was
  written. Prices are fetched live; the order is not re-ranked live, because the free quote source has no
  market cap.
- **API:** `GET /api/discovery/countries` and `GET /api/discovery/countries/{iso2}`.

## Intrinsic Valuation Station (left rail, `frontend/src/components/IntrinsicValuationStation.tsx`)

The Station values
the focused company per diluted share, in its reporting currency (formulas in `frontend/src/lib/intrinsic.ts`):

| Model | Formula | Inputs |
| --- | --- | --- |
| CAPM | kₑ = r_f + β × ERP | r_f: cached 10-year Treasury yield. β: peer-group beta from Damodaran. ERP: 4.46% |
| Multi-stage DCF | FCF₀ = latest revenue × 3-year pooled FCF margin. Years 1–5 grow at g, scaled by m/m₀. Years 6–10 fade linearly to 2.5%. Then a terminal value. All discounted at kₑ | SEC revenue and free cash flow, plus the center panel's growth and margin sliders. Shows equity value and EV (equity + long-term debt − cash) |
| Gordon Growth DDM | D₀ (1+g_d) ÷ (kₑ − g_d) | dividends paid ÷ diluted shares. g_d defaults to the company's dividend-per-share growth, capped at min(r_f, kₑ − 2pp) |
| Benjamin Graham | EPS × (8.5 + 2g) × 4.4 ÷ r_f (in %) | latest SEC diluted EPS, the growth slider |
| GuruFocus-style DCF | EPS·x(1−x¹⁰)/(1−x) + EPS·x¹⁰·y(1−y¹⁰)/(1−y) + tangible book per share. x = (1+g₁)/(1+d), y = 1.04/(1+d), d = r_f + 6% | latest diluted EPS. g₁ = historical 10-year EPS CAGR (5- or 3-year fallback, split-adjusted). Tangible book = equity − goodwill & intangibles (`frontend/src/lib/gurufocusDcf.ts`) |

- Each target price carries a margin-of-safety badge, (value − price) ÷ value. It's emerald when positive and crimson when negative.
  Past −100%, the badge shows price ÷ value instead (e.g. "4.2× value").
- The growth and margin sliders are shared with the center Valuation panel through `ValuationAssumptionsProvider`.
- **⚡ Sync Live Market Factors** calls `POST /api/macro/sync`, which runs only when clicked.
  - It queries Treasury and FRED in parallel, each within an 8-second budget, and keeps the newest reading.
  - It never replaces a newer cached rate with an older one.
  - The new rate overwrites the risk-free rate in the panel immediately.
- The macro cache is read from disk on every request; nothing is held in memory.
- Free cash flow is derived only when capex is reported. A missing capex tag is no longer treated as zero capex.
- **Audit (October 2026):**
  - The DCF base year is normalized because one year's capex can swing FCF heavily. Microsoft's FY2026 AI capex
    ($115.9B, 63% of operating cash flow) cut its FCF margin to 20%, from 25–33% in prior years.
  - Growth now fades over years 6–10 instead of dropping off a cliff.
  - The DDM's growth ceiling was 1pp under kₑ, which valued Microsoft's 0.7%-yield dividend at $390. It is now
    min(r_f, kₑ − 2pp).
  - Graham still divides by r_f as specified. Graham's own version uses the AAA corporate yield (6.15% vs 5.10% in
    October 2026), so it reads about 21% high. It also reads high whenever g is well above 10%.

## SEC access

Every request to the SEC sends `User-Agent: InvestmentStation student@domain.com`
(configured in `backend/app/core/config.py`, overridable via `IS_SEC_USER_AGENT`).
The client also rate-limits to 10 req/s per SEC fair-access policy and caches responses for an hour.

## GAAP tag normalization

`backend/app/services/gaap_mapping.py` maps varied US-GAAP tags onto four internal metrics.
Tags are tried in priority order per period, so history stays continuous when a company
switches tags (e.g. `SalesRevenueNet` → `RevenueFromContractWithCustomerExcludingAssessedTax` after ASC 606).

| Internal metric | US-GAAP tags (priority order) |
| --- | --- |
| `revenue` | Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, …IncludingAssessedTax, SalesRevenueNet, SalesRevenueGoodsNet, SalesRevenueServicesNet, RevenuesNetOfInterestExpense, RevenueNet |
| `cost_of_goods_sold` | CostOfRevenue, CostOfGoodsAndServicesSold, CostOfGoodsSold, CostOfServices, …ExcludingDepreciationDepletionAndAmortization variants |
| `operating_income` | OperatingIncomeLoss |
| `net_income` | NetIncomeLoss, ProfitLoss, NetIncomeLossAvailableToCommonStockholdersBasic |

Each returned value includes its `source_tag` and filing accession number for traceability.
Restated figures use the most recently filed value.

### Balance sheet

Balance-sheet facts are point-in-time values. Each period gets the balance sheet as of its end date,
and the one as of its start date (used for average assets). Tags: cash (`CashAndCashEquivalentsAtCarryingValue`),
short-term investments, receivables, `InventoryNet`, `AssetsCurrent`, `Assets`, `LiabilitiesCurrent`,
`Liabilities` and `StockholdersEquity`. When a filer doesn't tag `Liabilities`, it's derived as
`LiabilitiesAndStockholdersEquity − Equity (incl. NCI)`.

## Audit ratios (`backend/app/services/ratios.py`)

| Ratio | Formula |
| --- | --- |
| Current Ratio | Current Assets ÷ Current Liabilities |
| Quick Ratio | (Cash + Short-Term Investments + Receivables) ÷ Current Liabilities; falls back to (Current Assets − Inventory) when cash isn't tagged |
| Debt-to-Equity | Total Liabilities ÷ Stockholders' Equity (n/m when equity ≤ 0) |
| Gross / Operating / Net Margin % | Gross Profit, Operating Income or Net Income ÷ Revenue × 100 |
| Asset Turnover | Revenue ÷ Average Total Assets (quarterly figures are not annualized) |

## Material variance (`backend/app/services/variance.py`)

Every line item is compared with the **same fiscal period of the prior year**: FY vs prior FY, and Q3 vs the prior
year's Q3 (never the previous quarter). The prior period is matched by dates (ending 357–378 days earlier,
same length, which covers 52/53-week years), and fiscal labels break ties. An item is flagged when
`|current − prior| ÷ |prior|` is **more than** 10% in either direction; exactly 10% isn't flagged. Any move off a
zero base is also flagged. The threshold is set with `variance_threshold`.

Each flagged item also gets a `severity_tier` (by absolute change) and a `direction`. The UI shows them as mirrored badges:

| Tier | Change | Drop | Surge |
| --- | --- | --- | --- |
| 1 | 10–19.9% | muted amber | muted emerald |
| 2 | 20–29.9% | orange | emerald |
| 3 | 30–39.9% | soft crimson | deep emerald |
| 4 | ≥ 40% (or off a $0 base) | vivid crimson + alert icon | vivid emerald + alert icon |

## Design system

The look is a monochrome terminal: zinc surfaces and hairline borders, charcoal ink, and slate for secondary text.
The tokens live in `frontend/src/app/globals.css`, along with shared `panel`, `eyebrow`, `field`, `btn-*` and `link` classes, and each token has a dark-mode value.
Color is reserved for meaning: variance badges, the two chart series (palette checked for colorblind safety), and errors.

## Valuation panel (`frontend/src/lib/valuation.ts`)

Three sliders (Revenue Growth −20…+50%, Target Operating Margin 0…100%, WACC 5…20%) drive a 5-year projection
that recalculates in the browser on every input. The chart is built with Recharts, and its animation is turned off
so it updates instantly.

- Revenue grows at the chosen rate. Operating income = revenue × target margin.
- Earnings = operating income × the company's 3-year average (net income ÷ operating income). This carries forward its tax and interest load.
- FCF = earnings × the 3-year average (free cash flow ÷ net income). Free cash flow = operating cash flow − capex.
- DCF enterprise value = present value of the 5 projected FCFs + a Gordon-growth terminal value at 2.5%.
- Defaults: growth = 3-year revenue CAGR, margin = the latest operating margin, WACC = 9%.

## Watchlist & Holdings (`frontend/src/lib/portfolioStore.ts`)

The left rail has no input forms. Add the focused company to the watchlist with "+ Add", and click a saved
ticker to load it. Holdings recorded before the forms were removed are still listed (read-only, removable).

Saved in `localStorage` under `investment-station:portfolio:v1` and synced across open tabs. localStorage is
unencrypted and readable by any script on the page's origin, so only tickers, share counts and cost basis are kept.
Everything read back is treated as untrusted: tickers must match a strict pattern, numbers must be finite and
positive, lists are de-duplicated and capped at 50, and malformed entries are dropped. If storage is blocked,
the lists fall back to memory for the current session.

## Context pane: news (the MD&A narrative panel has been removed from the UI; `/api/companies/{id}/narrative` still exists)

Right-hand pane on wide screens (stacks below the statements on narrower ones). Its top half is news; its bottom half is the narrative summary.

**Related News:** `GET /api/companies/{ticker}/news`. Returns the 10 newest headlines for `"<TICKER>" stock` from the last 7 days.
- Source: Google News RSS (`backend/app/services/news.py`), which needs no API key. It's intended for personal, non-commercial use, so swap in a licensed news API before shipping commercially.
- The feed is parsed with `defusedxml`. Only `http(s)` links are kept, and syndicated duplicates are dropped.
- Results are cached for 5 minutes.

**Narrative Summary:** `GET /api/companies/{ticker}/narrative`
1. `mdna.py` finds the latest 10-K in the Submissions data and downloads its primary document from the EDGAR archive, sending the SEC User-Agent.
2. It flattens the HTML to text, skipping the hidden inline-XBRL header.
3. It isolates **Item 7**: the longest span from a line-start "Item 7. Management's Discussion and Analysis" heading to the next line-start "Item 7A" / "Item 8" heading. Taking the longest span skips the table-of-contents entry, and the line-start rule skips in-text cross-references.
4. `narrative.py` sends the full MD&A, never truncated, to **Claude Opus 5.5** (`claude-opus-5-5`, effort `medium`) with structured JSON output. Claude returns 4 bullets tagged `operational_headwind`, `supply_chain` or `forward_risk`, each with a supporting quote. The server-side refusal fallback is on (`fallbacks: "default"`).
5. Each quote is checked against the MD&A text (`quote_verified`). Summaries are cached per filing for 24 hours, so Claude is called once per 10-K.

Needs `ANTHROPIC_API_KEY` in the backend environment or `backend/.env`. Without it, the endpoint returns 503 and the rest of the app works.
Banks and other companies that incorporate the MD&A by reference to an exhibit return 404.

## Comparison matrix (`frontend/src/components/FinancialsTable.tsx`)

**Ratio accordions:** every audit-ratio row expands to show:
- **In the label column:** the formula, where to find its inputs in the statements, and how to read it.
- **Under each company:** a short analysis generated from that company's own numbers (`frontend/src/lib/ratioInsights.ts`).

The analysis covers:
- what drives the ratio, e.g. Apple's cash pile against current liabilities, or how much of a quick-ratio gap is inventory;
- the change from the same period a year earlier;
- how it compares with the other columns. It only calls a value "strongest" or "weakest" within one industry;
- qualitative industry context from the company's peer group, e.g. Walmart's asset turnover read as high-volume retail efficiency.

Every number comes from the statements, and a sentence is skipped when its inputs aren't reported. The row
grows to the tallest panel, so the columns stay aligned.

Up to 3 companies side by side, one column each. Rows are line items, audit ratios and forensic scores.
- **State:** shared app-wide state in `frontend/src/lib/comparisonStore.tsx` (React context + reducer).
- **Adding:** the search box appends a column rather than replacing the view. Re-entering a company already in the matrix focuses its column instead of adding one. That includes a CIK for a company already shown by ticker.
- **Focus:** clicking a column header focuses it. Valuation, news, the MD&A narrative and filings follow the focused company.
- **Period picker:** Latest / −1Y … −4Y (or quarters). Each column shows its own company's fiscal period at that offset.
- **Animation:** new columns enter with a Framer Motion spring (slide + fade + un-blur), and the existing columns glide aside. With reduced motion turned on, columns only fade.

## Forensic scores (`backend/app/services/forensics.py`, annual periods only)

| Score | Reading |
| --- | --- |
| Piotroski F-score | 9 binary signals (profitability, leverage/liquidity, efficiency vs. prior year). ≥ 7 strong, ≤ 3 weak. Withheld when fewer than 7 signals have data |
| Altman Z''-score | Book-equity variant (no market prices needed): 6.56·WC/TA + 3.26·RE/TA + 6.72·EBIT/TA + 1.05·Equity/TL. > 2.6 safe, < 1.1 distress. Needs current assets and current liabilities reported separately, so most banks get none |
| Sloan accrual ratio | (Net income − operating cash flow) ÷ average total assets. Above 10% means earnings are running ahead of cash |

Supporting line items added: diluted shares (reported in shares, not dollars), retained earnings, long-term debt.

## Peer suggestions (`backend/app/services/peers.py`)

`GET /api/companies/{ticker}/peers` reads the company's SIC code from the Submissions endpoint and returns curated industry peers. Example: AAPL (SIC 3571, "Big Tech") → MSFT, GOOGL, NVDA, AMZN, META.

SIC codes are too fine-grained to match on directly (Apple 3571, Microsoft 7372, Alphabet 7370, NVIDIA 3674), and a few are misleading (Uber, PayPal and Visa all share 7389). So the lookup runs in this order:
1. **Ticker override:** a short list of companies whose SIC code doesn't match their business.
2. **Exact SIC code** → one of 33 named peer groups.
3. **2-digit SIC major group** fallback (e.g. any 60xx → Banks).

The SIC assignments come from the companies' own EDGAR filings. The company itself and any ticker EDGAR doesn't recognize are left out of the suggestions.

**Frontend:** the focused company's peers appear as pills under the search bar. A pill shares a Framer Motion `layoutId` with its matrix column header, so clicking it flies the ticker into the new column as that column slides in. Pills for companies already compared are hidden, and all pills are disabled once 3 companies are in the matrix.
