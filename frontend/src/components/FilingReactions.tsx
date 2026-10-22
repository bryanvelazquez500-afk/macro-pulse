"use client";

/**
 * Filing reactions: a historical event study. The price chart marks the session each earnings release
 * (8-K Item 2.02, paired with its 10-Q / 10-K) reached the market, and the table lines up the filing's
 * reported changes with how the stock moved versus the market. Research only — it describes what
 * happened; it doesn't forecast. The math lives in backend/app/services/filing_reactions.py.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Segmented } from "@/components/Segmented";
import { FilingReactions as Data, ReactionEvent, fetchFilingReactions } from "@/lib/api";
import { CompanyEntry, symbolOf } from "@/lib/comparisonStore";
import { REACTION_STEPS, heat } from "@/lib/heat";
import { flow } from "@/lib/motion";
import { Pt, smoothArea, smoothLine } from "@/lib/smoothPath";
import { useFetch } from "@/lib/useFetch";

const RANGES = [
  { key: "1", label: "1 year" },
  { key: "3", label: "3 years" },
  { key: "5", label: "5 years" },
  { key: "10", label: "10 years" },
] as const;
type Range = (typeof RANGES)[number]["key"];

const TH = "border-b border-line-strong bg-panel px-3 py-3 text-[11px] leading-4 font-bold tracking-[0.09em] whitespace-nowrap text-ink-3 uppercase";
const TD = "border-t border-line px-3 py-2.5";


const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;

function Move({ v, strong = false }: { v: number | null | undefined; strong?: boolean }) {
  if (v == null) return <span className="text-ink-3">—</span>;
  const up = v >= 0;
  return (
    <span className={`whitespace-nowrap tabular-nums ${strong ? "font-semibold" : ""} ${up ? "text-gain" : "text-loss"}`}>
      <span aria-hidden>{up ? "▲" : "▼"}</span> {pct(v)}
    </span>
  );
}

/** Abnormal (company-specific) move in a heat square; ink on stronger steps for contrast. */
function AbnormalSquare({ v }: { v: number | null }) {
  const h = heat(v, REACTION_STEPS);
  if (v == null || !h) return <span className="text-ink-3">—</span>;
  const up = v >= 0;
  const color = h.step === 4 ? (up ? "text-on-surge-4" : "text-on-drop-4") : h.step >= 2 ? "text-ink" : up ? "text-gain" : "text-loss";
  return (
    <span className={`inline-block rounded-xs px-2 py-1 font-semibold tabular-nums ${color}`} style={{ backgroundColor: h.bg }}>
      <span aria-hidden>{up ? "▲" : "▼"}</span> {pct(v)}
    </span>
  );
}

const sessionLabel = (s: ReactionEvent["session"]) => ({ "before open": "Before open", "during market": "During market", "after close": "After close" })[s];

function eventLabel(e: ReactionEvent) {
  return e.fundamentals.period_label ?? `${e.report_form} · ${e.period_end ?? e.report_filed}`;
}

// ── chart ───────────────────────────────────────────────────────────────────

function PriceChart({
  data,
  selected,
  onSelect,
}: {
  data: Data;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const prices = data.prices;
  const H = 280;
  const pad = { l: 56, r: 20, t: 18, b: 30 };
  const index = useMemo(() => new Map(prices.map((p, i) => [p.d, i])), [prices]);
  if (prices.length < 2) return <p className="py-10 text-center text-[13px] text-ink-3">Price history is unavailable right now.</p>;

  const lo = Math.min(...prices.map((p) => p.c));
  const hi = Math.max(...prices.map((p) => p.c));
  const span = hi - lo || 1;
  const [y0, y1] = [lo - span * 0.06, hi + span * 0.1];
  const sx = (i: number) => pad.l + (i / (prices.length - 1)) * (width - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  // ~1 point per 2px keeps the path light on 10 years of daily closes; the curve stays smooth.
  const stride = Math.max(1, Math.floor(prices.length / (width / 2)));
  const pts = prices.filter((_, i) => i % stride === 0 || i === prices.length - 1).map((p) => [sx(index.get(p.d)!), sy(p.c)] as Pt);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + (y1 - y0) * f);
  const years = [...new Set(prices.map((p) => p.d.slice(0, 4)))];
  const yearStep = Math.max(1, Math.ceil(years.length / 8));
  const markers = data.events
    .map((e, i) => ({ e, i, at: e.reaction_date ? index.get(e.reaction_date) : undefined }))
    .filter((m): m is { e: ReactionEvent; i: number; at: number } => m.at != null);
  const hovered = hover != null ? prices[hover] : null;

  return (
    <div ref={wrap} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`${data.symbol} adjusted share price with ${markers.length} earnings-release reactions marked`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const i = Math.round(((x - pad.l) / (width - pad.l - pad.r)) * (prices.length - 1));
          setHover(Math.max(0, Math.min(prices.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
            <text x={pad.l - 10} y={sy(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
              ${t >= 100 ? t.toFixed(0) : t.toFixed(2)}
            </text>
          </g>
        ))}
        {years.map((y, k) => {
          if (k % yearStep) return null;
          const i = prices.findIndex((p) => p.d.startsWith(y));
          return (
            <text key={y} x={sx(i)} y={H - 8} textAnchor="middle" className="fill-ink-3 text-[11px]">
              {y}
            </text>
          );
        })}
        <g key={`${data.symbol}-${prices.length}`}>
          <path d={smoothArea(pts, H - pad.b)} fill="var(--mint)" opacity={0.6} />
          <path d={smoothLine(pts)} pathLength={1} className="chart-draw" fill="none" stroke="var(--spruce)" strokeWidth={2} strokeLinecap="round" />
        </g>
        {/* Event markers: the session each earnings release reached the market. */}
        {markers.map(({ e, i, at }) => {
          const up = (e.abn_1d ?? 0) >= 0;
          const active = selected === i;
          const x = sx(at);
          const y = sy(prices[at].c);
          return (
            <g key={i} className="cursor-pointer" onClick={() => onSelect(i)} onMouseEnter={() => setHover(at)}>
              <line x1={x} x2={x} y1={pad.t} y2={H - pad.b} stroke={active ? "var(--ink-2)" : "var(--line-strong)"} strokeDasharray="3 4" />
              <circle cx={x} cy={y} r={active ? 7 : 5} fill={up ? "var(--gain)" : "var(--loss)"} stroke="var(--panel)" strokeWidth={2} />
              <rect x={x - 9} y={pad.t} width={18} height={H - pad.t - pad.b} fill="transparent" />
            </g>
          );
        })}
        {hover != null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" />}
      </svg>
      {hovered && (
        <HoverCard
          left={Math.min(Math.max(sx(hover!) - 130, 0), width - 260)}
          date={hovered.d}
          price={hovered.c}
          event={markers.find((m) => m.at === hover)?.e}
        />
      )}
    </div>
  );
}

function HoverCard({ left, date, price, event }: { left: number; date: string; price: number; event?: ReactionEvent }) {
  return (
    <div className="pointer-events-none absolute top-1 z-10 w-[260px] rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] shadow-2" style={{ left }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] text-ink-3">{date}</span>
        <span className="font-semibold text-ink tabular-nums">${price.toFixed(2)}</span>
      </div>
      {event && (
        <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
          <div className="font-semibold text-ink">{eventLabel(event)} release</div>
          <div className="flex justify-between gap-2 text-ink-3">
            Stock <Move v={event.ret_1d} />
          </div>
          <div className="flex justify-between gap-2 text-ink-3">
            Market (SPY) <Move v={event.mkt_1d} />
          </div>
          <div className="flex justify-between gap-2 text-ink-3">
            Abnormal <Move v={event.abn_1d} strong />
          </div>
        </div>
      )}
    </div>
  );
}

// ── table ───────────────────────────────────────────────────────────────────

function EventRow({ e, i, selected, onSelect }: { e: ReactionEvent; i: number; selected: boolean; onSelect: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const f = e.fundamentals;
  const bg = selected ? "bg-mint" : "bg-panel group-hover:bg-subtle";
  return (
    <Fragment>
      <tr className="group cursor-pointer" onClick={() => onSelect(i)} aria-selected={selected}>
        <th scope="row" className={`${TD} ${bg} sticky left-0 z-10 text-left whitespace-nowrap`}>
          <div className={`font-semibold ${selected ? "text-mint-ink" : "text-ink"}`}>{eventLabel(e)}</div>
          <div className="font-mono text-[12px] text-ink-3">
            {e.report_form} · filed {e.report_filed}
          </div>
        </th>
        <td className={`${TD} ${bg} whitespace-nowrap`}>
          <div className="font-mono text-[12px] text-ink-2">{e.event_accepted_et} ET</div>
          <div className="text-[12px] text-ink-3">
            {e.event_form === "8-K" ? "Earnings release" : `${e.event_form} filing`} · {sessionLabel(e.session).toLowerCase()}
            {e.reaction_date && (
              <>
                {" "}
                → <span className="font-mono">{e.reaction_date.slice(5)}</span>
              </>
            )}
          </div>
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <Move v={e.ret_1d} />
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <Move v={e.mkt_1d} />
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <AbnormalSquare v={e.abn_1d} />
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <Move v={e.abn_5d} />
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <Move v={f.revenue_yoy} />
        </td>
        <td className={`${TD} ${bg} text-right`}>
          <Move v={f.eps_yoy} />
        </td>
        <td className={`${TD} ${bg} text-right whitespace-nowrap`}>
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen((o) => !o);
              onSelect(i);
            }}
            aria-expanded={open}
            className={e.nuances.length ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            title={e.nuances.length ? e.nuances.map((n) => n.text).join("\n") : "Write a summary of this reaction"}
          >
            Summary
            {e.nuances.length > 0 && <span className="rounded-full bg-on-spruce/20 px-1.5 text-[11px] font-bold">{e.nuances.length}</span>}
          </button>
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {open && (
          <tr>
            <td colSpan={9} className="border-t border-line bg-canvas p-0">
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={flow(3)} className="overflow-hidden">
                <div className="space-y-3 px-5 py-4">
                  {e.nuances.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {e.nuances.map((n) => (
                        <span key={n.code} className="pill bg-caution-bg text-caution">
                          {n.code.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="max-w-4xl text-[14px] leading-6 text-ink-2">{e.summary}</p>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                    <a className="link" href={e.event_url} target="_blank" rel="noopener noreferrer">
                      {e.event_form === "8-K" ? "Earnings release (8-K)" : `${e.event_form} filing`} ↗
                    </a>
                    {e.event_url !== e.report_url && (
                      <a className="link" href={e.report_url} target="_blank" rel="noopener noreferrer">
                        {e.report_form} ↗
                      </a>
                    )}
                    <span className="text-ink-3">
                      β {e.beta?.toFixed(2) ?? "—"} · normal daily noise ±{e.sigma?.toFixed(1) ?? "—"}% · 3-day abnormal {pct(e.abn_3d)} · week before {pct(e.pre_5d_abn)}
                    </span>
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </Fragment>
  );
}

// ── section ─────────────────────────────────────────────────────────────────

function Reactions({ id, years }: { id: string; years: number }) {
  const state = useFetch((signal) => fetchFilingReactions(id, years, signal));
  const [selected, setSelected] = useState<number | null>(null);
  if (state.status === "loading") return <div className="panel h-[420px] animate-pulse" aria-busy="true" />;
  if (state.status === "error") return <p className="panel px-6 py-8 text-[14px] text-ink-3">{state.error}</p>;
  const data = state.data;
  const sel = selected != null ? data.events[selected] : null;
  const counted = data.events.filter((e) => e.abn_1d != null);
  const avgAbs = counted.length ? counted.reduce((s, e) => s + Math.abs(e.abn_1d!), 0) / counted.length : null;
  const ups = counted.filter((e) => e.abn_1d! > 0).length;

  return (
    <div className="space-y-5">
      {data.notes.map((n) => (
        <p key={n} className="rounded-sm bg-caution-bg px-4 py-2.5 text-[13px] leading-5 text-caution">
          {n}
        </p>
      ))}
      <div className="panel p-5 max-sm:p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="type-card text-ink">
            <span className="font-mono">{data.symbol}</span> share price · earnings releases marked
          </h4>
          <span className="flex items-center gap-4 text-[13px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-gain" /> rose vs market
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-loss" /> fell vs market
            </span>
            <span>adjusted close · click a marker</span>
          </span>
        </div>
        <PriceChart data={data} selected={selected} onSelect={setSelected} />
        {sel && (
          <div className="mt-3 rounded-md border border-line bg-canvas px-4 py-3 text-[14px] leading-6 text-ink-2">
            <span className="font-semibold text-ink">{eventLabel(sel)}: </span>
            {sel.summary}
          </div>
        )}
      </div>

      {counted.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Releases studied", String(counted.length)],
            ["Rose vs market", `${ups} of ${counted.length}`],
            ["Typical move (abs.)", avgAbs == null ? "—" : `±${avgAbs.toFixed(1)}%`],
            ["Flagged nuances", String(data.events.reduce((n, e) => n + e.nuances.length, 0))],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-line bg-panel p-4">
              <div className="eyebrow">{label}</div>
              <div className="type-big-figure mt-1 !text-[22px] text-ink">{value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-line bg-panel shadow-1">
        <div className="overflow-x-auto rounded-lg">
          <table className="w-full border-separate border-spacing-0 text-[14px]">
            <thead>
              <tr>
                <th className={`${TH} sticky left-0 z-20 text-left`}>Report</th>
                <th className={`${TH} text-left`}>Released (ET) → reaction session</th>
                <th className={`${TH} text-right`}>Stock</th>
                <th className={`${TH} text-right`}>Market</th>
                <th className={`${TH} text-right`} title="Stock move minus beta × market move, on the reaction day">
                  Abnormal 1d
                </th>
                <th className={`${TH} text-right`}>Abnormal 5d</th>
                <th className={`${TH} text-right`}>Revenue YoY</th>
                <th className={`${TH} text-right`}>EPS YoY</th>
                <th className={`${TH} text-right`}>Resume</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e, i) => (
                <EventRow key={`${e.report_filed}-${i}`} e={e} i={i} selected={selected === i} onSelect={setSelected} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.events.length === 0 && <p className="text-[14px] text-ink-3">No 10-K or 10-Q filings in this range.</p>}
    </div>
  );
}

export function FilingReactions({ entries, focusedId }: { entries: CompanyEntry[]; focusedId: string | null }) {
  // SEC filers only: the study needs 10-K/10-Q filings and their earnings 8-Ks.
  const eligible = entries.filter((e) => e.status === "ready" && e.profile?.cik);
  const [pick, setPick] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("5");
  if (eligible.length === 0) return null;
  const id = eligible.some((e) => e.id === pick) ? pick! : eligible.some((e) => e.id === focusedId) ? focusedId! : eligible[0].id;

  return (
    <section id="filing-reactions" aria-labelledby="fr-title" className="scroll-mt-28 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <div className="eyebrow !text-spruce">Market reaction to filings · historical research</div>
          <h2 id="fr-title" className="type-section mt-1 text-ink max-sm:!text-[24px] max-sm:!leading-[30px]">
            Filing reactions
          </h2>
          <p className="mt-1 text-[15px] text-ink-3">
            Each 10-Q and 10-K is lined up with its earnings release and the trading session that release reached, then compared with how
            the stock moved against the market.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {eligible.length > 1 && (
            <Segmented
              label="Company"
              value={id}
              onChange={setPick}
              options={eligible.map((e) => ({ key: e.id, label: <span className="font-mono">{symbolOf(e)}</span> }))}
            />
          )}
          <Segmented label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} />
        </div>
      </div>
      <Reactions key={`${id}:${range}`} id={id} years={Number(range)} />
      <p className="max-w-4xl text-[13px] leading-5 text-ink-3">
        Research, not prediction: these are past reactions and say nothing about future ones. Times are the SEC acceptance time in New
        York; releases after 4 pm or on non-trading days are measured on the next session. Returns use split- and dividend-adjusted
        closes. The &ldquo;expected&rdquo; move is the stock&apos;s beta (from the prior 250 sessions) times the S&amp;P 500&apos;s move
        (SPY); the abnormal return is the part the market didn&apos;t explain. Analyst consensus estimates aren&apos;t available from free
        public sources, so nuance flags compare the reaction with the filing&apos;s own year-over-year changes. 10-K rows use full-year
        figures.
      </p>
    </section>
  );
}
