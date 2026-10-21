"use client";

/**
 * Supply Chain Network: a force-directed web of a company's suppliers and clients (force-graph, HTML5
 * canvas, loaded only when this tab opens).
 *
 *   suppliers ──cyan──▶ company ──green──▶ clients      (fading lines, arrows and flowing particles)
 *
 * Nodes are glowing glass bubbles labelled "Name · TICKER"; private companies get a dashed, dim outline.
 * Clicking a company opens its relationship card: what flows between the two, verbatim sentences from
 * each side's latest annual report that name the other (with any disclosed figures), and — for public
 * companies — an "Add to comparison" action. The list beside the canvas carries the same data as text.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  RelationshipContext,
  RelationshipSide,
  SupplyChainEdge,
  SupplyChainGraph,
  SupplyChainNode,
  fetchRelationship,
  fetchSupplyChain,
} from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { TickerSuggestions } from "@/lib/useTickerSuggestions";

type GNode = SupplyChainNode & { x?: number; y?: number };
type GLink = Omit<SupplyChainEdge, "source" | "target"> & { source: string | GNode; target: string | GNode };

// Colors come from the theme tokens, so the web follows the Daylight / Night ledger theme. DOM elements use
// the CSS variables directly; the canvas reads their current values (see readPalette).
const EDGE_VAR: Record<SupplyChainEdge["type"], string> = { supplier: "--series-1", client: "--gain", peer: "--ink-3" };
const ROLE_VAR: Record<SupplyChainNode["role"], string> = { focus: "--spruce", supplier: "--series-1", client: "--gain", both: "--series-7" };
const ROLE_COLOR = Object.fromEntries(Object.entries(ROLE_VAR).map(([k, v]) => [k, `var(${v})`])) as Record<SupplyChainNode["role"], string>;

/** "#0e6b5c" → "14, 107, 92", for rgba() on the canvas. */
function rgbOf(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return Number.isNaN(n) ? "128, 128, 128" : `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

interface Palette {
  edge: Record<SupplyChainEdge["type"], string>;
  role: Record<SupplyChainNode["role"], string>;
  ink: string;
  ink3: string;
  panel: string;
  font: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    edge: { supplier: rgbOf(v(EDGE_VAR.supplier)), client: rgbOf(v(EDGE_VAR.client)), peer: rgbOf(v(EDGE_VAR.peer)) },
    role: { focus: rgbOf(v(ROLE_VAR.focus)), supplier: rgbOf(v(ROLE_VAR.supplier)), client: rgbOf(v(ROLE_VAR.client)), both: rgbOf(v(ROLE_VAR.both)) },
    ink: v("--ink"),
    ink3: v("--ink-3"),
    panel: v("--panel"),
    font: getComputedStyle(document.body).fontFamily,
  };
}
const HEIGHT = 560;

const label = (n: SupplyChainNode) => (n.ticker && n.ticker !== n.name ? `${n.name} · ${n.ticker}` : n.name);
const endpoint = (v: string | GNode) => (typeof v === "string" ? null : v);

function Graph({ data, onPick }: { data: SupplyChainGraph; onPick: (node: SupplyChainNode) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  // The canvas repaints every frame (particles keep it animating), so swapping the palette on a theme
  // change recolors the web in place without re-running the layout.
  const theme = useTheme();
  const palette = useRef<Palette | null>(null);
  useEffect(() => {
    palette.current = readPalette();
  }, [theme]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let graph: { _destructor(): void; width(w: number): unknown } | null = null;
    let ro: ResizeObserver | null = null;
    let cancelled = false;

    import("force-graph").then(({ default: ForceGraph }) => {
      if (cancelled) return;
      const nodes: GNode[] = data.nodes.map((n) => ({ ...n }));
      const links: GLink[] = data.edges.map((e) => ({ ...e }));
      const fg = new ForceGraph<GNode, GLink>(el)
        .width(el.clientWidth)
        .height(HEIGHT)
        .backgroundColor("rgba(0,0,0,0)")
        .graphData({ nodes, links })
        .nodeId("id")
        .nodeLabel((n) => (n.role === "focus" ? label(n) : `${label(n)}${n.public ? "" : " (private)"} — click for the relationship`))
        .nodeVal((n) => (n.role === "focus" ? 10 : 4))
        .nodeCanvasObject((n, ctx, scale) => {
          const pal = palette.current ?? readPalette();
          const r = n.role === "focus" ? 13 : 7.5;
          const rgb = pal.role[n.role];
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          // Ledger bubble: a panel-colored disc with a tinted fill and a solid rim (no glow).
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = pal.panel;
          ctx.fill();
          ctx.fillStyle = n.role === "focus" ? `rgba(${rgb}, 1)` : `rgba(${rgb}, ${n.public ? 0.22 : 0.08})`;
          ctx.fill();
          ctx.lineWidth = (n.role === "focus" ? 2.5 : 1.6) / Math.max(scale, 0.6);
          if (n.public) {
            ctx.setLineDash([]);
            ctx.strokeStyle = `rgba(${rgb}, 1)`;
          } else {
            ctx.setLineDash([3 / scale, 2.5 / scale]); // private: dashed rim
            ctx.strokeStyle = `rgba(${pal.edge.peer}, 0.8)`;
          }
          ctx.stroke();
          ctx.setLineDash([]);
          // Label under the bubble in ink, with a panel-colored halo so lines never camouflage it.
          const size = Math.max(12 / scale, 3);
          ctx.font = `${n.role === "focus" ? 700 : 600} ${size}px ${pal.font}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.lineJoin = "round";
          ctx.lineWidth = 4 / scale;
          ctx.strokeStyle = pal.panel;
          ctx.strokeText(label(n), x, y + r + 3 / scale);
          ctx.fillStyle = n.public ? pal.ink : pal.ink3;
          ctx.fillText(label(n), x, y + r + 3 / scale);
        })
        .nodePointerAreaPaint((n, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, n.role === "focus" ? 15 : 10, 0, 2 * Math.PI);
          ctx.fill();
        })
        // Fading neon lines: dim at the supplier, bright at the client.
        .linkColor(() => "rgba(0,0,0,0)")
        .linkCanvasObjectMode(() => "before")
        .linkCanvasObject((l, ctx, scale) => {
          const s = endpoint(l.source);
          const t = endpoint(l.target);
          if (!s || !t) return;
          const rgb = (palette.current ?? readPalette()).edge[l.type];
          const g = ctx.createLinearGradient(s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0);
          g.addColorStop(0, `rgba(${rgb}, 0.15)`);
          g.addColorStop(1, `rgba(${rgb}, ${l.type === "peer" ? 0.45 : 0.95})`);
          ctx.beginPath();
          ctx.moveTo(s.x ?? 0, s.y ?? 0);
          ctx.lineTo(t.x ?? 0, t.y ?? 0);
          ctx.strokeStyle = g;
          ctx.lineWidth = (l.revenue_pct ? 1 + l.revenue_pct / 10 : l.major ? 2.2 : 1.2) / Math.max(scale, 0.6);
          ctx.stroke();
        })
        .linkLabel((l) =>
          [l.product, l.revenue_pct != null ? `${l.revenue_pct}% of supplier revenue` : l.major ? "≥10% customer" : null].filter(Boolean).join(" · "),
        )
        .linkDirectionalArrowLength(5)
        .linkDirectionalArrowRelPos(0.92)
        .linkDirectionalArrowColor((l) => `rgba(${(palette.current ?? readPalette()).edge[l.type]}, 1)`)
        .linkDirectionalParticles((l) => (l.type === "peer" ? 0 : 2))
        .linkDirectionalParticleWidth(2.2)
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor((l) => `rgba(${(palette.current ?? readPalette()).edge[l.type]}, 1)`)
        .cooldownTicks(120)
        .onEngineStop(() => fg.zoomToFit(600, 60))
        .onNodeHover((n) => {
          el.style.cursor = n && n.role !== "focus" ? "pointer" : "default";
        })
        .onNodeClick((n) => {
          if (n.role !== "focus") pick.current(n);
        });
      // Bigger webs spread wider so labels don't collide.
      const n = nodes.length;
      fg.d3Force("charge")?.strength?.(-220 - n * 14);
      (fg.d3Force("link") as { distance?: (d: number) => void } | undefined)?.distance?.(70 + n * 4.5);
      graph = fg;
      ro = new ResizeObserver(() => fg.width(el.clientWidth));
      ro.observe(el);
    });

    return () => {
      cancelled = true;
      ro?.disconnect();
      graph?._destructor();
      el.replaceChildren();
    };
  }, [data]);

  return <div ref={host} className="w-full" style={{ height: HEIGHT }} aria-hidden />;
}

function Partner({
  node,
  edges,
  onInject,
  onExplore,
  onOpen,
}: {
  node: SupplyChainNode;
  edges: SupplyChainEdge[];
  onInject: (n: SupplyChainNode) => void;
  onExplore: (id: string) => void;
  onOpen: (n: SupplyChainNode) => void;
}) {
  const e = edges[0];
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle">
      <span
        aria-hidden
        className={`size-2.5 shrink-0 rounded-full ${node.public ? "" : "border border-dashed border-control-border"}`}
        style={node.public ? { backgroundColor: ROLE_COLOR[node.role] } : undefined}
      />
      <button type="button" onClick={() => onOpen(node)} className="min-w-0 flex-1 text-left" title="Show the relationship">
        <div className={`truncate text-[12px] hover:underline ${node.public ? "text-ink" : "text-ink-3"}`}>
          {node.name}
          {node.ticker && <span className="ml-1 font-mono text-[12px] text-spruce">{node.ticker}</span>}
          {!node.public && <span className="ml-1 text-[12px] text-ink-3">private</span>}
        </div>
        {e && (
          <div className="truncate text-[12px] text-ink-3" title={e.evidence ?? e.source_note ?? undefined}>
            {e.origin === "filing" && (
              <span className="mr-1 rounded bg-mint px-1 text-[12px] text-spruce">filing</span>
            )}
            {e.product ?? (e.origin === "filing" ? e.source_note : null)}
            {e.revenue_pct != null ? ` · ${e.revenue_pct}% of revenue` : e.major ? " · ≥10% customer" : ""}
          </div>
        )}
      </button>
      <button type="button" onClick={() => onExplore(node.id)} className="rounded px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-subtle hover:text-ink" title="Centre the web on this company">
        Explore
      </button>
      {node.public && (
        <button
          type="button"
          onClick={() => onInject(node)}
          className="rounded px-1.5 py-0.5 text-[12px] font-semibold text-gain ring-1 ring-gain/40 ring-inset hover:bg-gain-bg"
          aria-label={`Add ${node.ticker} to the financial comparison`}
        >
          + Compare
        </button>
      )}
    </li>
  );
}

/** Bold every name the partner goes by, so the quoted sentence reads at a glance. */
function Quote({ text, names }: { text: string; names: string[] }) {
  const parts = names.length ? text.split(new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")) : [text];
  return (
    <blockquote className="border-l-2 border-spruce/50 pl-2.5 text-[13px] leading-snug text-ink-2">
      “{parts.map((p, i) => (names.includes(p) ? <strong key={i} className="font-semibold text-ink">{p}</strong> : p))}”
    </blockquote>
  );
}

function SideNotes({ side, partner, partnerNames }: { side: RelationshipSide; partner: string; partnerNames: string[] }) {
  const n = side.note;
  if (!n) return <p className="text-[12px] text-ink-3">{side.name}: {side.status || "no filings available"}.</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px]">
        <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium text-spruce hover:underline">
          {side.name} · {n.form} filed {n.filed} ↗
        </a>
        <span className="text-ink-3">
          {n.updated_from ? `updated ${n.as_of}` : `recorded ${n.as_of}`}
        </span>
      </div>
      {n.excerpts.length === 0 ? (
        <p className="text-[12px] text-ink-3">This report doesn&apos;t name {partner}.</p>
      ) : (
        <>
          {!n.latest_names_partner && (
            <p className="text-[12px] text-caution">From an earlier report — {side.name}&apos;s latest annual report no longer names {partner}.</p>
          )}
          {n.excerpts.map((e) => (
            <Quote key={e} text={e} names={partnerNames} />
          ))}
          {n.figures.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              <span className="text-[10px] tracking-wide text-ink-3 uppercase">Disclosed figures</span>
              {n.figures.map((f) => (
                <span key={f} className="rounded bg-gain-bg px-1.5 py-0.5 text-[12px] font-semibold text-gain">
                  {f}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {side.status && <p className="text-[12px] text-ink-3">{side.status}</p>}
    </div>
  );
}

function RelationshipCard({
  focus,
  node,
  data,
  onClose,
  onInject,
  onExplore,
}: {
  focus: SupplyChainNode;
  node: SupplyChainNode;
  data: SupplyChainGraph;
  onClose: () => void;
  onInject: (n: SupplyChainNode) => void;
  onExplore: (id: string) => void;
}) {
  const links = data.edges.filter((e) => (e.source === focus.id && e.target === node.id) || (e.source === node.id && e.target === focus.id));
  const [state, setState] = useState<{ key: string; items?: RelationshipContext[]; error?: string } | null>(null);
  const key = `${focus.id}|${node.id}`;

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all(links.map((l) => fetchRelationship(l.source, l.target, ctrl.signal))).then(
      (items) => setState({ key, items }),
      (e) => !ctrl.signal.aborted && setState({ key, error: e instanceof Error ? e.message : "Request failed" }),
    );
    return () => ctrl.abort();
    // `links` is derived from (focus, node, data); the key captures it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = state?.key === key ? state : null;
  const names = (id: string) => data.nodes.find((n) => n.id === id)?.mentions ?? [id];
  return (
    <motion.aside
      role="dialog"
      aria-label={`Relationship between ${focus.name} and ${node.name}`}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className="absolute top-3 right-3 bottom-3 z-10 flex w-[min(400px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="eyebrow" style={{ color: ROLE_COLOR[node.role] }}>
            {node.role === "supplier" ? "Supplier" : node.role === "client" ? "Client" : "Supplier & client"} of {focus.name}
          </div>
          <h3 className="truncate text-[15px] font-semibold text-ink">{label(node)}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-1.5 text-ink-3 hover:bg-subtle hover:text-ink">
          ×
        </button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {!current && (
          <div className="space-y-2" aria-busy="true">
            <p className="text-[13px] text-ink-3">Reading both companies&apos; annual reports…</p>
            <div className="h-3 w-5/6 animate-pulse rounded bg-subtle" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-subtle" />
          </div>
        )}
        {current?.error && <p className="text-[12px] text-loss">Couldn&apos;t load the filings: {current.error}</p>}
        {current?.items?.map((r) => (
          <section key={`${r.supplier.company}>${r.client.company}`} className="space-y-2.5">
            <p className="text-[13px] leading-snug text-ink">{r.summary}</p>
            {(r.revenue_pct != null || r.source_note) && (
              <p className="rounded-md bg-subtle px-2.5 py-1.5 text-[12px] text-ink-2 ring-1 ring-line ring-inset">
                {r.revenue_pct != null && <span className="mr-1 font-semibold text-gain">{r.revenue_pct}%</span>}
                {r.source_note}
              </p>
            )}
            <div className="space-y-3 border-t border-line pt-2.5">
              <div className="eyebrow">What the filings say</div>
              <SideNotes side={r.supplier} partner={r.client.name} partnerNames={names(r.client.company)} />
              <SideNotes side={r.client} partner={r.supplier.name} partnerNames={names(r.supplier.company)} />
            </div>
          </section>
        ))}
        {current?.items && (
          <p className="text-[12px] leading-snug text-ink-3">
            Sentences are quoted word for word from each company&apos;s latest annual report (an earlier one only if the latest doesn&apos;t name the
            partner); figures appear only when the filing states them. A summary is rewritten only when a new filing says something new.
          </p>
        )}
      </div>
      <footer className="flex gap-2 border-t border-line px-4 py-3">
        {node.public && (
          <button
            type="button"
            onClick={() => onInject(node)}
            className="flex-1 rounded-md bg-gain px-3 py-1.5 text-[12px] font-bold text-on-spruce hover:brightness-110"
          >
            + Add {node.ticker} to comparison
          </button>
        )}
        <button type="button" onClick={() => onExplore(node.id)} className="rounded-md px-3 py-1.5 text-[12px] text-ink-2 ring-1 ring-line-strong ring-inset hover:bg-subtle">
          Explore its web →
        </button>
      </footer>
    </motion.aside>
  );
}

export function SupplyChainNetwork({ focusTicker, onInject }: { focusTicker: string | null; onInject: (ticker: string) => void }) {
  const [explore, setExplore] = useState<string | null>(null);
  const [selected, setSelected] = useState<SupplyChainNode | null>(null);
  const [query, setQuery] = useState("");
  const target = explore ?? focusTicker ?? "AAPL";
  const [state, setState] = useState<{ key: string; data?: SupplyChainGraph; error?: string } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchSupplyChain(target, ctrl.signal).then(
      (data) => {
        setState({ key: target, data });
      },
      (e) => !ctrl.signal.aborted && setState({ key: target, error: e instanceof Error ? e.message : "Request failed" }),
    );
    return () => ctrl.abort();
  }, [target]);

  const current = state?.key === target ? state : null;
  const data = current?.data;
  const groups = useMemo(() => {
    if (!data) return null;
    const by = (role: SupplyChainNode["role"][]) => data.nodes.filter((n) => role.includes(n.role));
    const edgesFor = (n: SupplyChainNode) => data.edges.filter((e) => (e.source === n.id || e.target === n.id) && e.type !== "peer");
    return { suppliers: by(["supplier", "both"]), clients: by(["client", "both"]), edgesFor };
  }, [data]);
  const focusNode = data?.nodes.find((n) => n.role === "focus");
  const inject = (n: SupplyChainNode) => n.ticker && onInject(n.ticker);
  const exploreTo = (id: string) => {
    setSelected(null);
    setExplore(id);
  };
  const shownSelected = selected && data?.nodes.some((n) => n.id === selected.id) ? selected : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Suppliers → company → clients</div>
          <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-ink">
            {focusNode ? label(focusNode) : target} <span className="text-ink-3">supply chain</span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-6 rounded bg-gradient-to-r from-transparent to-[var(--series-1)]" /> supplier → company
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-6 rounded bg-gradient-to-r from-transparent to-gain" /> company → client
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-dashed border-control-border" /> private
          </span>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = query.trim().toUpperCase();
          if (t) exploreTo(t);
        }}
        className="flex flex-wrap items-center gap-2"
        role="search"
        aria-label="Explore a company's supply chain"
      >
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[12px] text-ink-3">
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            list="supply-chain-tickers"
            placeholder="Any ticker — NVDA, ASML, CRWV…"
            aria-label="Ticker to explore"
            maxLength={16}
            className="h-9 w-full rounded-lg bg-canvas pr-3 pl-8 font-mono text-[12.5px] text-ink uppercase ring-1 ring-line outline-none ring-inset placeholder:text-ink-4 placeholder:normal-case focus:ring-spruce"
          />
          <TickerSuggestions id="supply-chain-tickers" query={query} />
        </div>
        <button type="submit" disabled={!query.trim()} className="h-9 rounded-lg bg-mint px-4 text-[12px] font-semibold text-spruce ring-1 ring-spruce/50 ring-inset hover:bg-mint disabled:opacity-40">
          Map it
        </button>
        {explore && (
          <button type="button" onClick={() => setExplore(null)} className="text-[13px] text-spruce hover:underline">
            ↺ back to {focusTicker ?? "focused company"}
          </button>
        )}
        {data?.filing && (
          <a href={data.filing.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[12px] text-ink-3 hover:text-ink">
            Includes links named in {data.focus}&apos;s {data.filing.form} filed {data.filing.filed} ↗
          </a>
        )}
      </form>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative overflow-hidden rounded-lg border border-line bg-panel shadow-1" style={{ minHeight: HEIGHT }}>
          {!current && (
            <div className="absolute inset-0 grid place-items-center px-6 text-center text-[12px] text-ink-3">
              Mapping {target}&apos;s supply chain… the first look at a company reads its latest annual report, which can take a few seconds.
            </div>
          )}
          {current?.error && <div className="absolute inset-0 grid place-items-center text-[12px] text-loss">Couldn&apos;t load the supply chain: {current.error}</div>}
          {data && data.edges.length === 0 && (
            <div className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] leading-relaxed text-ink-3">
              <div>
                No supplier or customer relationships found for <span className="font-mono text-ink">{data.focus}</span>.
                <div className="mt-1 text-[13px] text-ink-3">
                  {data.filing
                    ? `Its ${data.filing.form} filed ${data.filing.filed} doesn't name any partners as companies, and it isn't in the curated set.`
                    : data.filing_status || "It isn't an SEC filer and isn't in the curated set."}
                </div>
              </div>
            </div>
          )}
          {data && data.edges.length > 0 && <Graph key={data.focus} data={data} onPick={setSelected} />}
          <AnimatePresence>
            {shownSelected && focusNode && data && (
              <RelationshipCard
                key={shownSelected.id}
                focus={focusNode}
                node={shownSelected}
                data={data}
                onClose={() => setSelected(null)}
                onInject={inject}
                onExplore={exploreTo}
              />
            )}
          </AnimatePresence>
          {data && data.edges.length > 0 && (
            <p className="pointer-events-none absolute bottom-3 left-4 text-[12px] text-ink-3">Drag to pan · scroll to zoom · click a company to see the relationship</p>
          )}
        </div>

        {groups && data && data.edges.length > 0 && (
          <aside className="panel max-h-[560px] space-y-3 overflow-y-auto p-3" aria-label="Suppliers and clients">
            {(
              [
                ["Suppliers", groups.suppliers, ROLE_COLOR.supplier],
                ["Clients", groups.clients, ROLE_COLOR.client],
              ] as const
            ).map(([title, list, rgb]) => (
              <section key={title}>
                <h3 className="eyebrow mb-1 flex items-center justify-between" style={{ color: rgb }}>
                  {title} <span className="text-ink-3">{list.length}</span>
                </h3>
                {list.length === 0 ? (
                  <p className="px-2 text-[12px] text-ink-3">None mapped.</p>
                ) : (
                  <ul>
                    {list.map((n) => (
                      <Partner key={n.id} node={n} edges={groups.edgesFor(n)} onInject={inject} onExplore={exploreTo} onOpen={setSelected} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
            <p className="border-t border-line pt-2 text-[12px] leading-snug text-ink-3">
              Curated from company disclosures and widely reported relationships. Revenue shares appear only where the supplier&apos;s own
              annual report states them.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Neon-green confirmation banner for an injected ticker. */
export function InjectBanner({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key={message}
          role="status"
          initial={{ opacity: 0, y: -24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ type: "spring", stiffness: 380, damping: 26 }}
          className="fixed inset-x-0 top-28 z-[80] mx-auto w-fit rounded-full bg-gain px-5 py-2.5 text-[14px] font-bold text-on-surge-4 shadow-2"
        >
          ✓ {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
