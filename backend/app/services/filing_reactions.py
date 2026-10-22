"""How the market reacted to each periodic filing — a historical event study, not a forecast.

Each 10-Q / 10-K is paired with the earnings release that preceded it (an 8-K with Item 2.02), because
that is when the numbers became public; the 10-Q itself usually adds little. The release's EDGAR
acceptance time (UTC) is converted to New York time and placed in the trading session it hit:

    before 9:30 ET on a trading day  → reaction measured that day         (prior close = previous day)
    9:30–16:00 ET                    → reaction measured that day         (partly intraday)
    after 16:00 ET, or a non-trading day → reaction measured the next session

Returns use split- and dividend-adjusted closes. The "expected" move is the stock's beta times the
market's move (SPY) over the same window — the standard market-model event study — so the abnormal
return is what the market did not explain. Beta and the normal day-to-day noise (σ) come from the 250
trading days before each event.

Fundamentals shown next to each reaction are the filing's own year-over-year changes. Consensus
analyst estimates aren't available from free public sources, so "expectations" here means the
market-model baseline, and nuance flags compare the reaction with what the filing reported.
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
MARKET = "SPY"
PERIODIC_FORMS = {"10-K", "10-Q", "20-F", "40-F"}
RELEASE_LOOKBACK_DAYS = 60  # an earnings 8-K this far before the 10-Q/10-K belongs to it
ESTIMATION_DAYS = 250


@dataclass
class Fundamentals:
    period_label: str | None = None
    revenue: float | None = None
    revenue_yoy: float | None = None
    net_income_yoy: float | None = None
    eps: float | None = None
    eps_yoy: float | None = None


@dataclass
class Nuance:
    code: str
    text: str


@dataclass
class ReactionEvent:
    report_form: str
    report_filed: str
    report_url: str
    period_end: str | None
    event_form: str  # "8-K" (earnings release) or the periodic form itself when no release was found
    event_accepted_et: str  # "2026-07-30 20:30"
    event_url: str
    session: str  # before open | during market | after close
    reaction_date: str | None
    prior_close: float | None = None
    close_1d: float | None = None
    ret_1d: float | None = None
    ret_3d: float | None = None
    ret_5d: float | None = None
    mkt_1d: float | None = None
    mkt_5d: float | None = None
    beta: float | None = None
    abn_1d: float | None = None
    abn_3d: float | None = None
    abn_5d: float | None = None
    pre_5d_abn: float | None = None
    sigma: float | None = None  # daily abnormal-return volatility, %
    z_1d: float | None = None
    fundamentals: Fundamentals = field(default_factory=Fundamentals)
    nuances: list[Nuance] = field(default_factory=list)
    summary: str = ""


# ── filings → events ─────────────────────────────────────────────────────────


def _doc_url(cik: int, accession: str, doc: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{doc}"


def _accepted_et(raw: str) -> datetime:
    """EDGAR acceptanceDateTime is UTC ("2026-07-31T00:30:28.000Z")."""
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(NY)


def pair_filings(submissions: dict, cik: int, years: int) -> list[dict]:
    """Periodic reports (newest first) with the earnings release each one followed."""
    r = submissions.get("filings", {}).get("recent", {})
    rows = [
        {
            "form": f,
            "filed": d,
            "accepted": a,
            "items": i or "",
            "report": rep or None,
            "accession": acc,
            "doc": doc,
        }
        for f, d, a, i, rep, acc, doc in zip(
            r.get("form", []),
            r.get("filingDate", []),
            r.get("acceptanceDateTime", []),
            r.get("items", []),
            r.get("reportDate", []),
            r.get("accessionNumber", []),
            r.get("primaryDocument", []),
        )
    ]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=365 * years + 30)).date().isoformat()
    releases = sorted((x for x in rows if x["form"] == "8-K" and "2.02" in x["items"]), key=lambda x: x["filed"])
    periodic = sorted((x for x in rows if x["form"] in PERIODIC_FORMS and x["filed"] >= cutoff), key=lambda x: x["filed"])
    used: set[str] = set()
    out: list[dict] = []
    for rep in periodic:
        lo = (datetime.fromisoformat(rep["filed"]) - timedelta(days=RELEASE_LOOKBACK_DAYS)).date().isoformat()
        candidates = [x for x in releases if lo <= x["filed"] <= rep["filed"] and x["accession"] not in used]
        release = candidates[-1] if candidates else None
        if release:
            used.add(release["accession"])
        event = release or rep
        out.append(
            {
                "report": rep,
                "event": event,
                "report_url": _doc_url(cik, rep["accession"], rep["doc"]),
                "event_url": _doc_url(cik, event["accession"], event["doc"]),
            }
        )
    return list(reversed(out))


def reaction_day(accepted: datetime, days: list[str]) -> tuple[int | None, str]:
    """Index of the first session that could react, and the session label."""
    d = accepted.date().isoformat()
    t = accepted.hour * 60 + accepted.minute
    trading = d in _day_set(days)
    if trading and t < 9 * 60 + 30:
        session, idx = "before open", bisect_left(days, d)
    elif trading and t < 16 * 60:
        session, idx = "during market", bisect_left(days, d)
    else:
        session, idx = "after close", bisect_right(days, d)
    return (idx if idx < len(days) else None), session


_DAYSETS: dict[int, set[str]] = {}


def _day_set(days: list[str]) -> set[str]:
    key = id(days)
    if key not in _DAYSETS:
        _DAYSETS.clear()
        _DAYSETS[key] = set(days)
    return _DAYSETS[key]


# ── statistics ───────────────────────────────────────────────────────────────


def _beta_sigma(stock: list[float], market: list[float], end: int) -> tuple[float, float | None]:
    """OLS beta of daily returns over the estimation window ending at index `end` (exclusive), and the
    standard deviation of the residual (abnormal) daily return, in %."""
    start = max(1, end - ESTIMATION_DAYS)
    rs = [stock[i] / stock[i - 1] - 1 for i in range(start, end)]
    rm = [market[i] / market[i - 1] - 1 for i in range(start, end)]
    n = len(rs)
    if n < 60:
        return 1.0, None
    ms, mm = sum(rs) / n, sum(rm) / n
    var = sum((x - mm) ** 2 for x in rm)
    beta = sum((a - ms) * (b - mm) for a, b in zip(rs, rm)) / var if var > 0 else 1.0
    resid = [a - beta * b for a, b in zip(rs, rm)]
    mr = sum(resid) / n
    sd = math.sqrt(sum((x - mr) ** 2 for x in resid) / (n - 1)) * 100
    return beta, sd


def _window(prices: list[float], k: int, n: int) -> float | None:
    """Return from the close before session k through the close of session k+n-1, in %."""
    j = k + n - 1
    if k < 1 or j >= len(prices):
        return None
    return (prices[j] / prices[k - 1] - 1) * 100


def measure(event: ReactionEvent, days: list[str], stock: list[float], market: list[float], k: int) -> None:
    beta, sigma = _beta_sigma(stock, market, max(1, k - 5))
    event.beta, event.sigma = round(beta, 2), (round(sigma, 2) if sigma else None)
    event.reaction_date = days[k]
    event.prior_close = round(stock[k - 1], 2) if k >= 1 else None
    event.close_1d = round(stock[k], 2)
    for n in (1, 3, 5):
        r, m = _window(stock, k, n), _window(market, k, n)
        setattr(event, f"ret_{n}d", None if r is None else round(r, 2))
        if n in (1, 5):
            setattr(event, f"mkt_{n}d", None if m is None else round(m, 2))
        setattr(event, f"abn_{n}d", None if r is None or m is None else round(r - beta * m, 2))
    if k >= 6:
        pr = (stock[k - 1] / stock[k - 6] - 1) * 100
        pm = (market[k - 1] / market[k - 6] - 1) * 100
        event.pre_5d_abn = round(pr - beta * pm, 2)
    if event.abn_1d is not None and sigma:
        event.z_1d = round(event.abn_1d / sigma, 1)


# ── fundamentals ─────────────────────────────────────────────────────────────


def _eps(p) -> float | None:
    li = p.line_items
    ni = (li.get("net_income_common") or li.get("net_income"))
    sh = li.get("diluted_shares")
    return ni.value / sh.value if ni and sh and sh.value else None


def fundamentals_for(period_end: str | None, periods: list) -> Fundamentals:
    """The reported period matching a filing's report date (within a week), with its YoY changes."""
    if not period_end or not periods:
        return Fundamentals()
    target = datetime.fromisoformat(period_end)
    match = min(periods, key=lambda p: abs((datetime.fromisoformat(p.end) - target).days))
    if abs((datetime.fromisoformat(match.end) - target).days) > 7:
        return Fundamentals()
    label = f"{match.fiscal_period} FY{match.fiscal_year}" if match.fiscal_period and match.fiscal_period != "FY" else f"FY{match.fiscal_year}"
    rev = match.line_items.get("revenue")
    v_rev, v_ni = match.variances.get("revenue"), match.variances.get("net_income")
    eps = _eps(match)
    prior = next(
        (p for p in periods if p.fiscal_period == match.fiscal_period and p.fiscal_year == (match.fiscal_year or 0) - 1),
        None,
    )
    prior_eps = _eps(prior) if prior else None
    eps_yoy = (eps - prior_eps) / abs(prior_eps) * 100 if eps is not None and prior_eps else None
    return Fundamentals(
        period_label=label,
        revenue=rev.value if rev else None,
        revenue_yoy=round(v_rev.change_pct, 1) if v_rev and v_rev.change_pct is not None else None,
        net_income_yoy=round(v_ni.change_pct, 1) if v_ni and v_ni.change_pct is not None else None,
        eps=round(eps, 2) if eps is not None else None,
        eps_yoy=round(eps_yoy, 1) if eps_yoy is not None else None,
    )


# ── nuance & summary ─────────────────────────────────────────────────────────


def _pct(v: float | None, signed: bool = True) -> str:
    if v is None:
        return "n/a"
    return f"{'+' if signed and v > 0 else '−' if v < 0 else ''}{abs(v):.1f}%"


def assess(e: ReactionEvent) -> None:
    """Flag reactions that don't read straight off the headline numbers, and write the summary."""
    f, n = e.fundamentals, []
    a1, a5 = e.abn_1d, e.abn_5d
    grew = [x for x in (f.revenue_yoy, f.net_income_yoy, f.eps_yoy) if x is not None]
    headline_up = bool(grew) and all(x > 0 for x in grew)
    headline_down = bool(grew) and all(x < 0 for x in grew)
    big = 2.5 * (e.sigma or 1.5)

    if a1 is not None:
        if headline_up and a1 <= -2:
            n.append(Nuance("fell_despite_growth", "Fell despite year-over-year growth — the results likely fell short of what the market had priced in."))
        if headline_down and a1 >= 2:
            n.append(Nuance("rose_despite_declines", "Rose despite year-over-year declines — the results were likely better than feared."))
        if abs(a1) < 1 and (e.sigma is None or abs(a1) < e.sigma):
            n.append(Nuance("muted", "Muted reaction — the results appear to have been largely priced in."))
        if e.z_1d is not None and abs(a1) >= big:
            n.append(Nuance("outsized", f"Unusually large move: about {abs(e.z_1d):.0f}× the stock's normal day-to-day noise."))
    if a1 is not None and a5 is not None and abs(a1) >= 1.5 and (a1 > 0) != (a5 > 0) and abs(a5 - a1) >= 3:
        n.append(Nuance("reversal", "The first-day reaction reversed within a week."))
    if a1 is not None and a5 is not None and (a1 > 0) == (a5 > 0) and abs(a5) >= abs(a1) + 3:
        n.append(Nuance("drift", "The move kept building over the following days (post-announcement drift)."))
    if e.pre_5d_abn is not None and abs(e.pre_5d_abn) >= 4:
        n.append(Nuance("run_up", f"Shares had already moved {_pct(e.pre_5d_abn)} versus the market in the week before the release."))
    if e.mkt_1d is not None and a1 is not None and abs(e.mkt_1d) >= 1.5 and abs(a1) < 1:
        n.append(Nuance("market_driven", "The day's move was mostly market-wide rather than company-specific."))
    if e.event_form in ("20-F", "40-F"):
        n.append(Nuance("annual_report_only", "Annual-report filing: this foreign filer publishes results earlier on 6-K forms, so this captures the report's filing, not the earnings news."))
    elif e.event_form != "8-K":
        n.append(Nuance("no_release", "No separate earnings release was found, so the reaction is timed to the filing itself."))
    e.nuances = n

    when = {"before open": "before the open", "during market": "during trading", "after close": "after the close"}[e.session]
    parts = [
        f"{f.period_label or e.report_form} results were released {when} on {e.event_accepted_et[:10]} "
        f"({e.event_form}); the reaction session was {e.reaction_date or 'not yet available'}."
    ]
    reported = [
        s
        for s in (
            f"revenue {_pct(f.revenue_yoy)} YoY" if f.revenue_yoy is not None else None,
            f"net income {_pct(f.net_income_yoy)}" if f.net_income_yoy is not None else None,
            f"diluted EPS {_pct(f.eps_yoy)}" if f.eps_yoy is not None else None,
        )
        if s
    ]
    if reported:
        parts.append("The filing reported " + ", ".join(reported) + ".")
    if e.ret_1d is not None:
        parts.append(
            f"Shares moved {_pct(e.ret_1d)} that session while the market moved {_pct(e.mkt_1d)}; "
            f"adjusting for the stock's beta of {e.beta:.2f}, the company-specific (abnormal) reaction was {_pct(e.abn_1d)}"
            + (f", and {_pct(e.abn_5d)} over five sessions." if e.abn_5d is not None else ".")
        )
    if n:
        parts.append("Nuance: " + " ".join(x.text for x in n))
    e.summary = " ".join(parts)


# ── entry point ──────────────────────────────────────────────────────────────


async def build_reactions(*, submissions: dict, cik: int, symbol: str, quotes, quarterly: list, annual: list, years: int = 5) -> dict:
    stock_bars = await quotes.get_daily_history(symbol, "10y")
    market_bars = await quotes.get_daily_history(MARKET, "10y")
    if not stock_bars or not market_bars:
        return {"symbol": symbol, "market": MARKET, "prices": [], "events": [], "notes": ["Price history is unavailable right now."]}
    mkt = dict(market_bars)
    aligned = [(d, c, mkt[d]) for d, c in stock_bars if d in mkt]
    days = [d for d, _, _ in aligned]
    stock = [c for _, c, _ in aligned]
    market = [m for _, _, m in aligned]

    events: list[ReactionEvent] = []
    for pair in pair_filings(submissions, cik, years):
        rep, ev = pair["report"], pair["event"]
        accepted = _accepted_et(ev["accepted"])
        e = ReactionEvent(
            report_form=rep["form"],
            report_filed=rep["filed"],
            report_url=pair["report_url"],
            period_end=rep["report"],
            event_form=ev["form"],
            event_accepted_et=accepted.strftime("%Y-%m-%d %H:%M"),
            event_url=pair["event_url"],
            session="",
            reaction_date=None,
        )
        k, e.session = reaction_day(accepted, days)
        if k is not None and k >= 1:
            measure(e, days, stock, market, k)
        source = annual if rep["form"] in ("10-K", "20-F", "40-F") else quarterly
        e.fundamentals = fundamentals_for(rep["report"], source)
        assess(e)
        events.append(e)

    notes = []
    if events and all(e.report_form in ("20-F", "40-F") for e in events):
        notes.append(
            "This company is a foreign filer: it files an annual 20-F/40-F and publishes quarterly results on 6-K forms, which EDGAR "
            "doesn't label as earnings. Only the annual-report filings are studied here, and they usually arrive weeks after the "
            "results were announced, so their reactions are typically small."
        )
    cutoff = (datetime.now(timezone.utc) - timedelta(days=365 * years + 30)).date().isoformat()
    start = bisect_left(days, cutoff)
    return {
        "symbol": symbol,
        "market": MARKET,
        "prices": [{"d": d, "c": round(c, 2)} for d, c in zip(days[start:], stock[start:])],
        "events": [asdict(e) for e in events],
        "notes": notes,
    }
