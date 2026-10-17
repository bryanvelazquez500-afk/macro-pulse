"""Material variance detection.

Every line item is compared with the same line item in the *same fiscal period
of the prior year* (FY vs prior FY, Q3 vs prior-year Q3 — never sequential
quarters, which would mostly flag seasonality). A line item is flagged when the
year-over-year swing exceeds the materiality threshold in either direction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.services.gaap_mapping import Metric, NormalizedPeriod

DEFAULT_MATERIALITY_THRESHOLD = 0.10

# Severity tiers for flagged items, by absolute YoY change: [10, 20) → 1, [20, 30) → 2, [30, 40) → 3, ≥ 40 → 4.
# Tier 1 also covers anything flagged below 10% when a lower materiality threshold is requested.
SEVERITY_TIER_BOUNDS_PCT = (20.0, 30.0, 40.0)

# A prior-year period ends 52 or 53 weeks earlier (364 / 371 days) or one calendar year (365 / 366).
_PRIOR_YEAR_GAP_DAYS = range(357, 379)


@dataclass(frozen=True)
class VarianceResult:
    current_value: float
    prior_value: float
    # Signed percentage change, e.g. -12.5 means down 12.5%. None when the prior value is zero.
    change_pct: float | None
    flagged: bool
    direction: str  # "up" | "down" | "flat"
    # 1-4 for flagged items (see SEVERITY_TIER_BOUNDS_PCT); None when not flagged.
    severity_tier: int | None
    prior_period_end: str
    prior_fiscal_year: int | None
    prior_fiscal_period: str | None


def find_prior_year_period(period: NormalizedPeriod, candidates: list[NormalizedPeriod]) -> NormalizedPeriod | None:
    """Finds the same fiscal period one year earlier.

    Dates are authoritative (the period must end roughly one year before and span
    the same length); fiscal labels break ties when several periods qualify.
    """
    end = date.fromisoformat(period.end)
    length = (end - date.fromisoformat(period.start)).days

    matches = []
    for c in candidates:
        c_end = date.fromisoformat(c.end)
        if (end - c_end).days not in _PRIOR_YEAR_GAP_DAYS:
            continue
        if abs((c_end - date.fromisoformat(c.start)).days - length) > 10:
            continue
        label_match = (
            period.fiscal_year is not None
            and c.fiscal_year == period.fiscal_year - 1
            and c.fiscal_period == period.fiscal_period
        )
        matches.append((not label_match, abs((end - c_end).days - 365), c))

    return min(matches, key=lambda m: m[:2])[2] if matches else None


def compare(current: float, prior: float, threshold: float) -> tuple[float | None, bool]:
    if prior == 0:
        # Any movement off a zero base is material by definition.
        return None, current != 0
    change_pct = (current - prior) / abs(prior) * 100
    # Round away float noise so an exact 10.0% swing isn't flagged as "more than 10%".
    return change_pct, round(abs(change_pct), 6) > threshold * 100


def severity_tier(change_pct: float | None, flagged: bool) -> int | None:
    if not flagged:
        return None
    if change_pct is None:
        return len(SEVERITY_TIER_BOUNDS_PCT) + 1  # moved off a zero base: as severe as it gets
    magnitude = round(abs(change_pct), 6)
    return 1 + sum(magnitude >= bound for bound in SEVERITY_TIER_BOUNDS_PCT)


def compute_variances(
    periods: list[NormalizedPeriod],
    threshold: float = DEFAULT_MATERIALITY_THRESHOLD,
) -> dict[tuple[str, str], dict[Metric, VarianceResult]]:
    """Returns {period key: {metric: variance}} for every period with a prior-year match."""
    results: dict[tuple[str, str], dict[Metric, VarianceResult]] = {}
    for period in periods:
        prior = find_prior_year_period(period, periods)
        if prior is None:
            continue
        per_metric: dict[Metric, VarianceResult] = {}
        for metric, current in period.values.items():
            previous = prior.values.get(metric)
            if previous is None:
                continue
            change_pct, flagged = compare(current.value, previous.value, threshold)
            per_metric[metric] = VarianceResult(
                current_value=current.value,
                prior_value=previous.value,
                change_pct=change_pct,
                flagged=flagged,
                direction="up" if current.value > previous.value else "down" if current.value < previous.value else "flat",
                severity_tier=severity_tier(change_pct, flagged),
                prior_period_end=prior.end,
                prior_fiscal_year=prior.fiscal_year,
                prior_fiscal_period=prior.fiscal_period,
            )
        results[period.key] = per_metric
    return results
