"""Builds data/us_universe.json: every US-headquartered operating company listed on NYSE / Nasdaq / Cboe
that files with the SEC, with its SIC industry code and a GICS-style sector.

Usage (from backend/):
    .venv/bin/python scripts/build_us_universe.py /path/to/submissions.zip

Inputs are SEC bulk files, so the build makes one request for the ticker list plus one bulk download
(https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip, ~1.4 GB, passed in by path)
instead of thousands of per-company requests.
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings  # noqa: E402
from app.services.discovery import LEADERS  # noqa: E402
from app.services.filed_relationships import clean_title  # noqa: E402
from app.services.universe import EXCLUDED_SIC, UNIVERSE_PATH, sector_for_sic  # noqa: E402

EXCHANGES = {"NYSE", "Nasdaq", "CBOE"}
US_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA "
    "RI SC SD TN TX UT VT VA WA WV WI WY DC".split()
)
# Warrants, units, rights and preferred shares trade under suffixed tickers; only common stock is kept.
_NON_COMMON = re.compile(r"-(?:W|WT|WS|U|UN|R|RT|P[A-Z]?)$|\^")


def nice_name(name: str) -> str:
    """Readable casing for names EDGAR stores in capitals: "DELTA AIR LINES" → "Delta Air Lines", "IBM" stays."""
    name = re.sub(r",?\s+(?:Inc|Corp|Corporation|Co|Ltd|LLC|plc|Holdings Inc)\.?$", "", name.strip())
    name = re.sub(r"[\s,&]+$", "", name).strip()

    def word(w: str) -> str:
        w = re.sub(r"^Mc([a-z])", lambda m: "Mc" + m.group(1).upper(), w)  # Mccormick → McCormick
        if not w.isupper() or not w.isalpha():
            return w  # mixed case already, or AT&T / 3M style tokens
        if len(w) <= 4 and not re.search(r"[AEIOU]", w):
            return w  # acronyms: IBM, CVS, HP, NVR
        cased = w.capitalize()
        return re.sub(r"^Mc([a-z])", lambda m: "Mc" + m.group(1).upper(), cased)  # McCormick, McKesson

    return " ".join(word(w) for w in name.split())


def main(zip_path: str) -> None:
    settings = get_settings()
    rows = httpx.get(
        "https://www.sec.gov/files/company_tickers_exchange.json", headers={"User-Agent": settings.sec_user_agent}, timeout=60
    ).json()["data"]
    listed = [(cik, name, ticker.upper(), ex) for cik, name, ticker, ex in rows if ex in EXCHANGES and ticker]
    all_tickers = {t for _, _, t, _ in listed}
    elsewhere = {s for iso, entries in LEADERS.items() if iso != "US" for s, _, _ in entries}
    curated_us = {s: (n, sec) for s, n, sec in LEADERS["US"]}

    out, seen_cik = [], set()
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        for cik, title, ticker, exchange in listed:  # SEC orders tickers by size, primary class first
            if cik in seen_cik or ticker in elsewhere or _NON_COMMON.search(ticker):
                continue
            # Nasdaq's 5th-letter suffixes: W warrants, U units, R rights (when the 4-letter stock also trades).
            if len(ticker) == 5 and ticker[-1] in "WUR" and ticker[:4] in all_tickers:
                continue
            member = f"CIK{cik:010d}.json"
            if member not in names:
                continue
            sub = json.loads(z.read(member))
            state = ((sub.get("addresses") or {}).get("business") or {}).get("stateOrCountry")
            sic = int(sub["sic"]) if str(sub.get("sic") or "").isdigit() else None
            if state not in US_STATES or sic in EXCLUDED_SIC:
                continue
            sector = curated_us.get(ticker, (None, None))[1] or sector_for_sic(sic)
            if sector is None:
                continue
            seen_cik.add(cik)
            name = curated_us.get(ticker, (None, None))[0] or nice_name(clean_title(title) or title)
            out.append({"ticker": ticker, "cik": cik, "name": name, "exchange": exchange, "sic": sic, "sector": sector})

    UNIVERSE_PATH.write_text(
        json.dumps({"built": date.today().isoformat(), "source": "SEC company_tickers_exchange.json + submissions.zip", "listings": out}, separators=(",", ":")),
        encoding="utf-8",
    )
    by_sector: dict[str, int] = {}
    for row in out:
        by_sector[row["sector"]] = by_sector.get(row["sector"], 0) + 1
    print(f"{len(out)} US listings written to {UNIVERSE_PATH}")
    print(by_sector)


if __name__ == "__main__":
    main(sys.argv[1])
