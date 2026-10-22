"""Filing-reaction event study: release pairing, session timing, abnormal returns, nuance flags."""

from datetime import datetime

from app.services.filing_reactions import (
    Fundamentals,
    ReactionEvent,
    _accepted_et,
    assess,
    measure,
    pair_filings,
    reaction_day,
)

DAYS = ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]


def _subs(rows):
    keys = ["form", "filingDate", "acceptanceDateTime", "items", "reportDate", "accessionNumber", "primaryDocument"]
    return {"filings": {"recent": {k: [r[i] for r in rows] for i, k in enumerate(keys)}}}


def test_10q_pairs_with_its_earnings_release():
    subs = _subs([
        ("10-Q", "2026-07-31", "2026-07-31T14:01:02.000Z", "", "2026-06-27", "0001-26-000002", "q.htm"),
        ("8-K", "2026-07-30", "2026-07-31T00:30:28.000Z", "2.02,9.01", "2026-07-30", "0001-26-000001", "k.htm"),
        ("8-K", "2026-07-15", "2026-07-15T20:00:00.000Z", "5.07", "2026-07-15", "0001-26-000000", "v.htm"),  # not earnings
    ])  # fmt: skip
    (pair,) = pair_filings(subs, 320193, years=10)
    assert pair["event"]["form"] == "8-K" and pair["event"]["items"].startswith("2.02")
    assert pair["report_url"].endswith("/000126000002/q.htm")


def test_acceptance_is_utc_and_sessions_follow_new_york_time():
    # 00:30 UTC on Jul 31 is 20:30 EDT on Jul 30: after the close, so Jul 31 reacts.
    accepted = _accepted_et("2026-07-31T00:30:28.000Z")
    assert accepted.strftime("%Y-%m-%d %H:%M") == "2026-07-30 20:30"
    k, session = reaction_day(accepted, DAYS)
    assert (DAYS[k], session) == ("2026-07-31", "after close")
    # 11:00 UTC = 07:00 EDT: before the open, same day reacts.
    k, session = reaction_day(_accepted_et("2026-08-04T11:00:00.000Z"), DAYS)
    assert (DAYS[k], session) == ("2026-08-04", "before open")
    # Saturday release → next trading day (Monday).
    k, session = reaction_day(datetime.fromisoformat("2026-08-01T10:00:00-04:00"), DAYS)
    assert (DAYS[k], session) == ("2026-08-03", "after close")


def test_abnormal_return_removes_the_market_move():
    # 300 quiet days (stock = 2× market moves, so beta ≈ 2), then the event day.
    n = 300
    market = [100.0]
    stock = [100.0]
    for i in range(1, n):
        m = 0.004 if i % 2 else -0.003
        market.append(market[-1] * (1 + m))
        stock.append(stock[-1] * (1 + 2 * m))
    days = [f"d{i:04d}" for i in range(n + 5)]
    market += [market[-1] * 1.01] + [market[-1] * 1.01] * 4  # market +1% on the event day
    stock += [stock[-1] * 1.07] + [stock[-1] * 1.07] * 4  # stock +7%
    e = ReactionEvent("10-Q", "x", "u", None, "8-K", "x", "u", "after close", None)
    measure(e, days, stock, market, n)
    assert abs(e.beta - 2.0) < 0.05
    assert abs(e.ret_1d - 7.0) < 0.01 and abs(e.mkt_1d - 1.0) < 0.01
    assert abs(e.abn_1d - 5.0) < 0.1  # 7% − 2 × 1%


def _event(**kw):
    e = ReactionEvent("10-Q", "2026-07-31", "u", "2026-06-27", "8-K", "2026-07-30 20:30", "u", "after close", "2026-07-31")
    for k, v in kw.items():
        setattr(e, k, v)
    return e


def test_nuance_flags_and_summary():
    e = _event(ret_1d=-7.3, mkt_1d=0.7, beta=0.85, abn_1d=-8.0, abn_5d=-9.4, sigma=1.4, z_1d=-5.7,
               fundamentals=Fundamentals("Q3 FY2026", 1e11, 16.4, 27.1, 1.8, 29.1))  # fmt: skip
    assess(e)
    codes = {n.code for n in e.nuances}
    assert {"fell_despite_growth", "outsized"} <= codes
    assert "Q3 FY2026 results were released after the close on 2026-07-30" in e.summary
    assert "−8.0%" in e.summary

    calm = _event(ret_1d=0.4, mkt_1d=0.2, beta=1.0, abn_1d=0.2, abn_5d=0.3, sigma=1.4, z_1d=0.1, fundamentals=Fundamentals())
    assess(calm)
    assert [n.code for n in calm.nuances] == ["muted"]

    flip = _event(ret_1d=4, mkt_1d=0, beta=1.0, abn_1d=4.0, abn_5d=-1.5, sigma=1.4, z_1d=2.9, fundamentals=Fundamentals())
    assess(flip)
    assert "reversal" in {n.code for n in flip.nuances}
