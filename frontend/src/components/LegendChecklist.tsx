"use client";

import { AnimatePresence, Variants, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

import { ChecklistCriterion, ChecklistVerdict, InvestorChecklist, fetchChecklist } from "@/lib/api";
import { currencySymbol } from "@/lib/format";
import { useFetch } from "@/lib/useFetch";

// ---------------------------------------------------------------- verification icons
// Status is carried by shape + accessible text, never color alone: a check for passed,
// a warning triangle for failed, a dashed "?" for checks the data couldn't settle.

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <circle cx="10" cy="10" r="10" className="fill-emerald-600 dark:fill-emerald-500" />
      <path
        d="M5.8 10.3l2.7 2.7 5.7-5.9"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-white dark:stroke-emerald-950"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <path d="M8.6 2.4a1.6 1.6 0 0 1 2.8 0l7.4 13.2a1.6 1.6 0 0 1-1.4 2.4H2.6a1.6 1.6 0 0 1-1.4-2.4z" className="fill-red-600 dark:fill-red-500" />
      <path d="M10 7v4.4" strokeWidth="2" strokeLinecap="round" className="stroke-white dark:stroke-red-950" />
      <circle cx="10" cy="14.6" r="1.1" className="fill-white dark:fill-red-950" />
    </svg>
  );
}

function UnknownIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <circle cx="10" cy="10" r="8.8" fill="none" strokeWidth="1.5" strokeDasharray="3 2.4" className="stroke-ink-4" />
      <text x="10" y="14" textAnchor="middle" className="fill-ink-3 font-sans text-[10px] font-semibold">
        ?
      </text>
    </svg>
  );
}

const STATUS = {
  pass: { Icon: CheckIcon, sr: "Verified", tone: "text-ink" },
  fail: { Icon: WarningIcon, sr: "Warning — failed", tone: "text-ink" },
  unknown: { Icon: UnknownIcon, sr: "Not enough data", tone: "text-ink-3" },
} as const;

function statusOf(c: ChecklistCriterion) {
  return c.passed === true ? STATUS.pass : c.passed === false ? STATUS.fail : STATUS.unknown;
}

const VERDICT: Record<ChecklistVerdict, { label: string; className: string }> = {
  worth_buying: { label: "Worth Buying", className: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950" },
  pass: { label: "Pass", className: "bg-panel text-red-700 ring-1 ring-inset ring-red-600/40 dark:text-red-400 dark:ring-red-400/40" },
};

// ---------------------------------------------------------------- ripple entry
// Blocks enter as a wave from the top-left corner (delay grows with grid distance), each with a
// one-shot ring pulse; inside, the checks cascade down and their icons pop in behind them.

const GRID_COLUMNS = 2;

function rippleDelay(index: number) {
  const row = Math.floor(index / GRID_COLUMNS);
  const col = index % GRID_COLUMNS;
  return (row + col) * 0.11;
}

const blockVariants: Variants = {
  hidden: { opacity: 0, scale: 0.94, y: 14, filter: "blur(6px)" },
  shown: (delay: number) => ({
    opacity: 1,
    scale: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 260, damping: 26, delay, staggerChildren: 0.065, delayChildren: delay + 0.18 },
  }),
};

const rowVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  shown: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 380, damping: 30, staggerChildren: 0.08 } },
};

const iconVariants: Variants = {
  hidden: { scale: 0, rotate: -30 },
  shown: { scale: 1, rotate: 0, transition: { type: "spring", stiffness: 520, damping: 18 } },
};

// ---------------------------------------------------------------- criterion row

function CriterionRow({ c }: { c: ChecklistCriterion }) {
  const s = statusOf(c);
  return (
    <motion.li variants={rowVariants} className="flex items-start gap-3 py-3">
      <motion.span variants={iconVariants} className="mt-0.5 shrink-0" title={s.sr}>
        <s.Icon />
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug text-ink">
          <span className="sr-only">{s.sr}: </span>
          {c.label}
        </div>
        {c.display && <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{c.display}</p>}
        {c.note && <p className="mt-0.5 text-[11px] leading-snug text-ink-3 italic">{c.note}</p>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`font-mono text-[15px] font-semibold tabular-nums ${s.tone}`}>{c.value_label ?? "—"}</div>
        <div className="font-mono text-[10.5px] text-ink-4">target {c.rule}</div>
      </div>
    </motion.li>
  );
}

// ---------------------------------------------------------------- historical overlay

function ContextOverlay({ investor, side, id }: { investor: InvestorChecklist; side: "left" | "right"; id: string }) {
  const reduceMotion = useReducedMotion();
  const { context, criteria } = investor;
  const offset = side === "right" ? -14 : 14;
  return (
    <motion.aside
      id={id}
      aria-label={`${investor.name}: history and rationale`}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: offset, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: offset / 2, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 340, damping: 30 }}
      // Below lg it covers its own block (opened by tap); on wide screens it opens beside the block,
      // over the neighbouring column, so the hovered block's checks stay readable.
      className={`absolute inset-0 z-10 overflow-y-auto rounded-xl bg-panel p-5 shadow-2xl ring-1 ring-line-strong lg:inset-auto lg:top-0 lg:max-h-[min(80vh,680px)] lg:w-full ${
        side === "right" ? "lg:left-[calc(100%+1.25rem)]" : "lg:right-[calc(100%+1.25rem)]"
      }`}
    >
      <p className="eyebrow">{context.tenure}</p>

      <section className="mt-3">
        <h5 className="text-[12px] font-semibold text-ink">Investment rationale</h5>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{context.approach}</p>
      </section>

      <section className="mt-4">
        <h5 className="text-[12px] font-semibold text-ink">Past allocations</h5>
        <ol className="relative mt-2 space-y-2.5 border-l border-line pl-4">
          {context.allocations.map((a) => (
            <li key={a.company} className="relative">
              <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-ink ring-4 ring-panel" aria-hidden />
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10.5px] text-ink-3">{a.period}</span>
                <span className="text-[12.5px] font-medium text-ink">{a.company}</span>
                {a.ticker && <span className="font-mono text-[10.5px] text-ink-4">{a.ticker}</span>}
              </div>
              <p className="text-[11.5px] leading-snug text-ink-2">{a.thesis}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
          <span className="font-medium text-ink-2">
            Case study — {context.case_study.company}, {context.case_study.period}:
          </span>{" "}
          {context.case_study.summary}
        </p>
      </section>

      <section className="mt-4">
        <h5 className="text-[12px] font-semibold text-ink">Why these metrics</h5>
        <ul className="mt-2 space-y-2">
          {criteria.map((c) => {
            const s = statusOf(c);
            return (
              <li key={c.key} className="flex gap-2.5">
                <span className="mt-px shrink-0 scale-[0.8]">
                  <s.Icon />
                </span>
                <p className="text-[11.5px] leading-snug text-ink-2">
                  <span className="font-medium text-ink">{c.label}.</span> {context.metric_rationale[c.key]}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      {context.quote && (
        <blockquote className="mt-4 border-l-2 border-line-strong pl-3">
          <p className="text-[12px] text-ink">“{context.quote.text}”</p>
          <footer className="mt-0.5 text-[10.5px] text-ink-3">— {context.quote.source}</footer>
        </blockquote>
      )}
    </motion.aside>
  );
}

// ---------------------------------------------------------------- investor block

const HOVER_OPEN_MS = 280; // intent delay: sweeping the pointer across the grid shouldn't flash overlays
const HOVER_CLOSE_MS = 140;

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("");
}

function InvestorBlock({ investor, index }: { investor: InvestorChecklist; index: number }) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overlayId = useId();
  const side = index % GRID_COLUMNS === 0 ? "right" : "left";
  const verdict = VERDICT[investor.verdict];
  const met = investor.criteria.filter((c) => c.passed === true).length;
  const delay = reduceMotion ? 0 : rippleDelay(index);

  const schedule = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <motion.article
      custom={delay}
      variants={blockVariants}
      initial={reduceMotion ? false : "hidden"}
      animate="shown"
      whileHover={reduceMotion ? undefined : { scale: 1.025, transition: { type: "spring", stiffness: 300, damping: 22 } }}
      onHoverStart={() => schedule(true)}
      onHoverEnd={() => schedule(false)}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      style={{ zIndex: open ? 30 : 1 }}
      className="group relative flex flex-col rounded-xl bg-panel p-5 shadow-sm ring-1 ring-line transition-shadow duration-300 hover:shadow-xl hover:ring-line-strong"
      aria-label={`${investor.name}: ${verdict.label}, ${met} of ${investor.criteria.length} checks verified`}
    >
      {/* One-shot ripple ring on entry. */}
      {!reduceMotion && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-ink/25"
          initial={{ opacity: 0.7, scale: 0.97 }}
          animate={{ opacity: 0, scale: 1.06 }}
          transition={{ duration: 0.75, ease: "easeOut", delay }}
        />
      )}

      <header className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-inverse font-mono text-[12px] font-semibold tracking-wider text-on-inverse">
          {initials(investor.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-[15px] font-semibold tracking-tight text-ink">{investor.name}</h4>
          <p className="text-[11.5px] leading-snug text-ink-3">{investor.philosophy}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase ${verdict.className}`}
          title={investor.summary}
        >
          {verdict.label}
        </span>
      </header>

      {/* Segmented score bar: one segment per check. */}
      <div className="mt-4 flex gap-1" aria-hidden>
        {investor.criteria.map((c) => (
          <span
            key={c.key}
            className={`h-1 flex-1 rounded-full ${
              c.passed === true ? "bg-emerald-600 dark:bg-emerald-500" : c.passed === false ? "bg-red-600/70 dark:bg-red-500/70" : "bg-line-strong"
            }`}
          />
        ))}
      </div>

      <ul className="mt-1 flex-1 divide-y divide-line">
        {investor.criteria.map((c) => (
          <CriterionRow key={c.key} c={c} />
        ))}
      </ul>

      <footer className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="text-[11px] text-ink-3" title={investor.summary}>
          {met}/{investor.criteria.length} checks verified
        </span>
        {/* Hover isn't available on touch or keyboard: this opens the same overlay. */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={overlayId}
          onClick={() => {
            clearTimeout(timer.current);
            setOpen((o) => !o);
          }}
          className="rounded-md px-2 py-1 text-[11px] text-ink-3 transition-colors outline-none hover:bg-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          History &amp; rationale {open ? "×" : "→"}
        </button>
      </footer>

      <AnimatePresence>{open && <ContextOverlay investor={investor} side={side} id={overlayId} />}</AnimatePresence>
    </motion.article>
  );
}

// ---------------------------------------------------------------- panel

/** `replayKey` changes each time the Strategy view is opened, replaying the ripple without refetching. */
export function LegendChecklist({ identifier, replayKey = 0 }: { identifier: string; replayKey?: number }) {
  const state = useFetch((signal) => fetchChecklist(identifier, signal));

  if (state.status === "loading") {
    return (
      <div className="grid gap-5 lg:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-72 animate-pulse rounded-xl bg-subtle/60 ring-1 ring-line" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return <p className="panel px-4 py-3 text-[13px] text-ink-2">{state.error}</p>;
  }

  const { investors, price, price_note, fiscal_year, currency } = state.data;
  if (investors.length === 0) {
    return <p className="panel px-4 py-3 text-[13px] text-ink-2">No annual financials to evaluate.</p>;
  }
  const buys = investors.filter((i) => i.verdict === "worth_buying").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[12px] text-ink-3">
        <span>
          <span className="font-medium text-ink">
            {buys}/{investors.length}
          </span>{" "}
          legends would buy · FY{fiscal_year ?? "—"} filings ({currency}) · hover a legend for their history
        </span>
        <span title={price_note ?? undefined}>
          {price
            ? `Price ${currencySymbol(price.currency)}${price.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${price.source}${price.comparable ? "" : " · not used for P/E"}`
            : "No share price"}
        </span>
      </div>

      <div key={replayKey} className="grid items-start gap-5 lg:grid-cols-2">
        {investors.map((investor, i) => (
          <InvestorBlock key={investor.key} investor={investor} index={i} />
        ))}
      </div>

      <p className="text-[11px] text-ink-4">
        Mechanical screens inspired by each investor&apos;s published principles — not their actual process, and not investment advice. A
        check without enough data counts as not met.
      </p>
    </div>
  );
}
