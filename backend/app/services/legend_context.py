"""Historical narrative context for each legend, appended to their checklist.

Short, factual background: who they are, how they invest, one well-documented case study, and
how the case connects to the screens in `vetting.py`. Quotations are limited to widely attributed
lines with a known source. Dates and figures are deliberately conservative — rounded or omitted
where accounts differ.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CaseStudy:
    company: str
    ticker: str | None
    period: str
    summary: str
    # Criteria keys (see vetting.py) this episode illustrates.
    illustrates: tuple[str, ...] = ()


@dataclass(frozen=True)
class Quote:
    text: str
    source: str


@dataclass(frozen=True)
class Allocation:
    """A notable past position — company, when, and the one-line thesis."""

    company: str
    ticker: str | None
    period: str
    thesis: str


@dataclass(frozen=True)
class LegendContext:
    tenure: str
    approach: str
    case_study: CaseStudy
    quote: Quote | None = None
    rules_of_thumb: tuple[str, ...] = ()
    further_reading: tuple[str, ...] = field(default_factory=tuple)
    allocations: tuple[Allocation, ...] = ()
    # Criterion key (vetting.py) → why this investor cares about that number.
    metric_rationale: dict[str, str] = field(default_factory=dict)


LEGEND_CONTEXT: dict[str, LegendContext] = {
    "buffett": LegendContext(
        tenure="Ran Berkshire Hathaway from 1965; chairman from 1970",
        approach=(
            "Began as a Ben Graham bargain hunter, then — nudged by Munger — shifted to durable franchises: businesses with "
            "high returns on capital, pricing power and modest reinvestment needs, run by honest managers and held for decades."
        ),
        case_study=CaseStudy(
            company="Apple",
            ticker="AAPL",
            period="2016–2024",
            summary=(
                "Berkshire first disclosed an Apple stake in 2016 and kept buying through 2018 until it became Berkshire's largest "
                "holding. Buffett framed Apple as a consumer franchise rather than a tech bet: customers locked into its ecosystem, "
                "enormous free cash flow, and steady buybacks that lifted Berkshire's ownership share without it buying another "
                "share. Berkshire sold roughly two-thirds of the position during 2024."
            ),
            illustrates=("roic", "share_count", "capex_to_ocf"),
        ),
        quote=Quote(
            "It's far better to buy a wonderful company at a fair price than a fair company at a wonderful price.",
            "Berkshire Hathaway shareholder letter, 1989",
        ),
        rules_of_thumb=(
            "Owner earnings: cash the business generates after the capex needed to stay competitive",
            "Buybacks only below intrinsic value — then they compound per-share value",
            "A moat shows up as stable margins and returns that competitors can't erode",
        ),
        further_reading=("Berkshire Hathaway shareholder letters (berkshirehathaway.com)",),
        allocations=(
            Allocation("American Express", "AXP", "1964", "Bought after the salad-oil scandal: the card franchise and customer trust were intact"),
            Allocation("Coca-Cola", "KO", "1988", "A global brand with pricing power and little capital need — still held"),
            Allocation("GEICO", None, "1996", "Took full ownership of a low-cost insurer whose float funds Berkshire's investments"),
            Allocation("Apple", "AAPL", "2016", "A consumer ecosystem throwing off cash, with buybacks shrinking the share count"),
        ),
        metric_rationale={
            "roic": "The clearest sign of a moat: each dollar retained earns well above its cost.",
            "gross_margin_stability": "Pricing power shows up as margins that hold through good and bad years.",
            "capex_to_ocf": "Owner earnings are cash left after the reinvestment needed to stay competitive.",
            "share_count": "Buybacks below intrinsic value raise every remaining owner's share of the business.",
            "margin_expansion": "A widening moat lets a business earn more on each sale over time.",
        },
    ),
    "lynch": LegendContext(
        tenure="Managed Fidelity's Magellan Fund, 1977–1990",
        approach=(
            "Grew Magellan from a small fund into one of the world's largest by owning hundreds of growth stocks he understood, "
            "sorted into categories (slow growers, stalwarts, fast growers, cyclicals, turnarounds, asset plays). He judged a "
            "fast grower fairly priced when its P/E was no higher than its growth rate, and always checked the balance sheet."
        ),
        case_study=CaseStudy(
            company="Hanes (L'eggs pantyhose)",
            ticker=None,
            period="1970s",
            summary=(
                "Lynch's best-known example of 'invest in what you know': his wife was a fan of L'eggs, Hanes' pantyhose sold in "
                "supermarkets in egg-shaped packaging. The product's popularity sent him to the numbers, and Hanes became one of "
                "Magellan's big winners — the kind of everyday discovery he argued amateurs could make before Wall Street did."
            ),
            illustrates=("peg", "inventory_vs_sales"),
        ),
        quote=Quote("Know what you own, and know why you own it.", "Peter Lynch, One Up on Wall Street (1989)"),
        rules_of_thumb=(
            "PEG below 1 is attractive; well above 1 means you're paying up for growth",
            "Inventories growing faster than sales are a warning sign",
            "Net cash (cash minus long-term debt) is a cushion — and part of what you're buying",
        ),
        further_reading=("One Up on Wall Street (1989)", "Beating the Street (1993)"),
        allocations=(
            Allocation("Hanes", None, "1970s", "Spotted L'eggs on supermarket shelves before analysts covered it"),
            Allocation("Chrysler", None, "Early 1980s", "A turnaround bought when bankruptcy fears had crushed the price"),
            Allocation("Fannie Mae", None, "1980s", "A misunderstood stalwart whose earnings power the market underrated"),
        ),
        metric_rationale={
            "peg": "A P/E only means something next to growth; paying less than the growth rate is the bargain.",
            "inventory_vs_sales": "Stock piling up faster than sales often precedes markdowns and earnings misses.",
            "net_cash": "Cash beyond debt is a safety net in bad years — and part of what the buyer gets.",
        },
    ),
    "munger": LegendContext(
        tenure="Vice chairman of Berkshire Hathaway, 1978–2023",
        approach=(
            "Built a 'latticework of mental models' from many disciplines and applied it with extreme selectivity: a few great "
            "businesses, bought at fair prices, held with little or no leverage. He studied failure as much as success — "
            "asking what would destroy a business, then avoiding it."
        ),
        case_study=CaseStudy(
            company="See's Candies",
            ticker=None,
            period="1972",
            summary=(
                "Blue Chip Stamps, controlled by Buffett and Munger, bought See's Candies in 1972 for $25 million — about three "
                "times its tangible net worth, a price a strict Graham investor would have refused. See's raised prices year "
                "after year without losing customers and needed little new capital, sending decades of cash to Berkshire to "
                "invest elsewhere. Both men credited it with teaching them what a great business is worth. Munger later served "
                "on Costco's board from 1997 until his death, another business he admired for its cost discipline."
            ),
            illustrates=("gross_margin", "sga_stability", "leverage"),
        ),
        quote=Quote("Invert, always invert.", "Charlie Munger, borrowing from mathematician Carl Jacobi"),
        rules_of_thumb=(
            "High gross margins signal pricing power; disciplined overhead keeps it",
            "Avoid leverage — it's how smart people go broke",
            "Sit on your hands until a great business is available at a fair price",
        ),
        further_reading=("Poor Charlie's Almanack (2005)",),
        allocations=(
            Allocation("See's Candies", None, "1972", "Paid up for a brand that could raise prices every year"),
            Allocation("Costco", "COST", "1997–2023", "Board member and long-time admirer of its low-cost, member-funded model"),
            Allocation("BYD", None, "2008", "Pushed Berkshire to back the Chinese battery and car maker early"),
        ),
        metric_rationale={
            "piotroski": "A quick screen for a business that's getting stronger, not quietly weakening.",
            "leverage": "Debt is how good businesses fail; without it, time is on the owner's side.",
            "gross_margin": "Customers paying well above cost is the plainest evidence of a franchise.",
            "sga_stability": "Overhead that creeps up as a share of sales signals a business losing discipline.",
        },
    ),
    "ackman": LegendContext(
        tenure="Founded Pershing Square Capital Management in 2004",
        approach=(
            "Runs a concentrated portfolio of large, high-quality companies, often as an engaged or activist shareholder. "
            "Pershing Square's published criteria: simple, predictable, free-cash-flow-generative businesses with formidable "
            "barriers to entry, limited exposure to factors outside their control, strong balance sheets, and an attractive "
            "price relative to free cash flow."
        ),
        case_study=CaseStudy(
            company="Chipotle Mexican Grill",
            ticker="CMG",
            period="2016–2018",
            summary=(
                "Pershing Square disclosed a stake of roughly 10% in Chipotle in 2016, after food-safety outbreaks had sent the "
                "shares sharply lower. Ackman argued the brand and its unit economics were intact and the problems fixable; he "
                "pushed for board changes, and in 2018 Chipotle hired Brian Niccol as CEO, after which the business recovered strongly."
            ),
            illustrates=("operating_leverage", "recurring_fcf"),
        ),
        rules_of_thumb=(
            "Franchise rule: prefer asset-light models whose fees recur with little capital — Pershing has owned franchisors "
            "such as Restaurant Brands (Burger King, from 2012) and Hilton (from 2018)",
            "Operating leverage: as revenue grows on a largely fixed cost base, margins widen",
            "Buy at a free-cash-flow yield that makes sense without heroic growth",
        ),
        further_reading=("Pershing Square Holdings annual reports and investor presentations",),
        allocations=(
            Allocation("Canadian Pacific", "CP", "2011", "Activist campaign that installed new management and transformed the railroad's efficiency"),
            Allocation("Burger King / Restaurant Brands", "QSR", "2012", "Asset-light franchisor collecting royalties on others' capital"),
            Allocation("Chipotle", "CMG", "2016", "A great brand temporarily broken by fixable food-safety problems"),
            Allocation("Hilton", "HLT", "2018", "Fee-based hotel franchising with recurring, capital-light cash flow"),
        ),
        metric_rationale={
            "operating_leverage": "On a largely fixed cost base, each extra dollar of revenue drops more to profit.",
            "recurring_fcf": "Predictable cash every year is what lets a business compound — and fund buybacks.",
            "fcf_yield": "The price paid has to make sense on today's cash, without heroic growth assumptions.",
        },
    ),
}
