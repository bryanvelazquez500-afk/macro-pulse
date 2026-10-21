"use client";

/**
 * Equity Discovery — a scout-map view of world markets.
 *
 * World view: continents light up on hover; click one to fly the camera in. Region view: every country
 * in the region is hoverable and clickable, with labels sized to the zoom; covered markets carry a
 * pulsing scout marker. Clicking a country slides in its largest listed companies with live quotes.
 *
 * Geometry: Natural Earth 1:50m admin-0 countries (public domain), pre-simplified to TopoJSON in
 * /public/geo, drawn with d3-geo (Natural Earth projection). The camera is an SVG transform tweened
 * with Framer Motion; strokes use non-scaling-stroke so borders stay crisp at any zoom.
 */

import { animate, AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

import { UnavailableButton } from "@/components/UnavailableButton";
import {
  CountryLeaders,
  Coverage,
  Leader,
  fetchCountryLeaders,
  fetchDiscoveryCountries,
} from "@/lib/api";
import { currencySymbol } from "@/lib/format";
import { useFetch } from "@/lib/useFetch";

// ---------------------------------------------------------------- geography

interface CountryProps {
  iso: string;
  name: string;
  continent: string;
  lx: number; // label anchor (lon/lat), from Natural Earth
  ly: number;
  ml: number; // Natural Earth MIN_LABEL: lower = more prominent
}
type CountryFeature = Feature<Geometry, CountryProps>;

const W = 960;
const H = 500;

const REGIONS = [
  {
    key: "North America",
    label: "North America",
    bounds: [
      [-168, 7],
      [-52, 72],
    ],
    anchor: [-102, 46],
  },
  {
    key: "South America",
    label: "South America",
    bounds: [
      [-82, -56],
      [-34, 13],
    ],
    anchor: [-60, -16],
  },
  {
    key: "Europe",
    label: "Europe",
    bounds: [
      [-25, 34],
      [45, 71],
    ],
    anchor: [16, 53],
  },
  {
    key: "Africa",
    label: "Africa",
    bounds: [
      [-18, -35],
      [52, 37],
    ],
    anchor: [20, 5],
  },
  {
    key: "Asia",
    label: "Asia",
    bounds: [
      [26, -11],
      [146, 56],
    ],
    anchor: [96, 42],
  },
  {
    key: "Oceania",
    label: "Oceania",
    bounds: [
      [112, -48],
      [180, -8],
    ],
    anchor: [138, -26],
  },
] as const;
type RegionKey = (typeof REGIONS)[number]["key"];

const flag = (iso: string) =>
  /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "🏳️";

function useWorld() {
  const state = useFetch(async (signal) => {
    const res = await fetch("/geo/world-50m.topo.json", { signal });
    if (!res.ok) throw new Error("Couldn't load the world map");
    const topo = (await res.json()) as Topology<{ countries: GeometryCollection<CountryProps> }>;
    return feature(topo, topo.objects.countries) as FeatureCollection<Geometry, CountryProps>;
  });
  return useMemo(() => {
    if (state.status !== "success") return { status: state.status, error: state.status === "error" ? state.error : null } as const;
    const projection = geoNaturalEarth1().fitExtent(
      [
        [12, 12],
        [W - 12, H - 12],
      ],
      state.data,
    );
    const path = geoPath(projection);
    const countries = state.data.features.map((f) => ({ f: f as CountryFeature, d: path(f) ?? "" }));
    return { status: "success", projection, countries } as const;
  }, [state]);
}

type Camera = { x: number; y: number; k: number };
const WORLD: Camera = { x: 0, y: 0, k: 1 };

function cameraFor(projection: (p: [number, number]) => [number, number] | null, bounds: readonly (readonly [number, number])[]): Camera {
  // Sample the bounding box edges: the projection is curved, so corners alone under-estimate the extent.
  const [[x0, y0], [x1, y1]] = bounds;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const lon = x0 + ((x1 - x0) * i) / 8;
    const lat = y0 + ((y1 - y0) * i) / 8;
    pts.push([lon, y0], [lon, y1], [x0, lat], [x1, lat]);
  }
  const projected = pts.map((p) => projection(p)).filter((p): p is [number, number] => !!p);
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(W / (maxX - minX), H / (maxY - minY)) * 0.94;
  return { k, x: W / 2 - k * ((minX + maxX) / 2), y: H / 2 - k * ((minY + maxY) / 2) };
}

/**
 * Greedy label placement: covered markets first, then by Natural Earth prominence (MIN_LABEL); a label
 * whose estimated box overlaps one already placed is dropped, so dense regions (Benelux) stay legible.
 */
function placeLabels(
  countries: CountryProps[],
  project: (p: CountryProps) => [number, number] | null,
  isCovered: (p: CountryProps) => boolean,
  k: number,
) {
  const placed: { p: CountryProps; x: number; y: number; size: number; isCovered: boolean; box: [number, number, number, number] }[] = [];
  const ordered = [...countries].sort((a, b) => Number(isCovered(b)) - Number(isCovered(a)) || a.ml - b.ml);
  for (const p of ordered) {
    const xy = project(p);
    if (!xy) continue;
    const covered = isCovered(p);
    const size = (covered ? 10.5 : 8.5) / k;
    const width = p.name.length * size * 0.66 + 4 / k; // uppercase semibold ≈ 0.66em per glyph
    const x = xy[0];
    const y = xy[1] - 6 / k;
    const box: [number, number, number, number] = [x - width / 2, y - size, x + width / 2, y + size * 0.25];
    const collides = placed.some(({ box: b }) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    if (!collides) placed.push({ p, x, y, size, isCovered: covered, box });
  }
  return placed;
}

// ---------------------------------------------------------------- overlay panel

const COVERAGE: Record<Coverage, { label: string; className: string; title: string }> = {
  sec: { label: "SEC", className: "text-emerald-300 ring-emerald-400/40", title: "Full statements from SEC filings — free" },
  fmp: { label: "FMP", className: "text-sky-300 ring-sky-400/40", title: "Statements from Financial Modeling Prep" },
  fmp_key_required: {
    label: "FMP key",
    className: "text-amber-300 ring-amber-400/40",
    title: "Not an SEC registrant: full statements need a paid Financial Modeling Prep key",
  },
  unavailable: { label: "No data", className: "text-slate-400 ring-slate-500/40", title: "Not found in either data pipeline" },
};

/** 5.16T / 412B / 980M — for market caps. */
function compactMoney(v: number, currency: string) {
  const [scale, suffix] = v >= 1e12 ? [1e12, "T"] : v >= 1e9 ? [1e9, "B"] : [1e6, "M"];
  return `${currencySymbol(currency)}${(v / scale).toFixed(v / scale >= 100 ? 0 : 1)}${suffix}`;
}

function money(v: number, currency: string) {
  const big = Math.abs(v) >= 1000;
  return `${currencySymbol(currency)}${v.toLocaleString("en-US", { maximumFractionDigits: big ? 0 : 2, minimumFractionDigits: big ? 0 : 2 })}`;
}

/**
 * One listing: name, ticker, live price and market cap. No valuation is fetched from here — the arrow
 * adds the company to the comparison (Raw Financial Statements), and the DCF Calculator values it there. Opening a country
 * therefore never triggers per-company SEC downloads.
 */
function StockRow({ leader, onAnalyze }: { leader: Leader; onAnalyze: (symbol: string) => void }) {
  const s = leader.snapshot;
  const cov = COVERAGE[leader.coverage];
  // Listings whose statements need an API key stay in the list; clicking the row (or its button) explains
  // that the info is unavailable at the moment, instead of loading a column that can't fill.
  const keyRequired = leader.coverage === "fmp_key_required";
  const [explaining, setExplaining] = useState(false);
  return (
    <div
      className={`mp-interactive group relative flex h-full items-center gap-3 rounded-md border-b border-white/[0.06] px-3 ${keyRequired ? "cursor-pointer" : ""}`}
      onClick={keyRequired ? () => setExplaining((o) => !o) : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-white">{leader.name}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
          <span className="font-mono font-semibold text-cyan-300">{leader.symbol}</span>
          {!keyRequired && (
            <span
              className={`rounded px-1 text-[9px] font-semibold tracking-wider uppercase ring-1 ring-inset ${cov.className}`}
              title={cov.title}
            >
              {cov.label}
            </span>
          )}
          {leader.market_cap != null && s && (
            <span className="shrink-0 font-mono text-slate-500 tabular-nums" title="Live market cap: price × shares outstanding (SEC)">
              {compactMoney(leader.market_cap, s.currency)}
            </span>
          )}
          {s && (
            <span className="truncate font-mono text-slate-400 tabular-nums">
              {money(s.price, s.currency)}
              {s.change_pct != null && (
                <span className={s.change_pct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  {" "}
                  {s.change_pct >= 0 ? "+" : "−"}
                  {Math.abs(s.change_pct).toFixed(1)}%
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {keyRequired ? (
        <UnavailableButton subject={leader.name} compact open={explaining} onOpenChange={setExplaining} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => onAnalyze(leader.symbol)}
            aria-label={`Add ${leader.name} to comparison`}
            title="Add to the comparison (up to 3) and open Raw Financial Statements"
            className="grid size-7 shrink-0 place-items-center rounded-md text-cyan-200 ring-1 ring-cyan-400/30 transition hover:bg-cyan-400/15 focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
          >
            →
          </button>
        </>
      )}
    </div>
  );
}

// Virtualized, sector-grouped list: fixed row heights, so offsets are a prefix sum and only the rows
// in (and just around) the viewport are mounted — long lists (60+ US listings) stay smooth, and only
// on-screen rows are in the DOM.
const HEADER_H = 34;
const ROW_H = 64;
const OVERSCAN_PX = 240;

type Item = { kind: "header"; sector: string; count: number } | { kind: "row"; leader: Leader };

function SectorList({ data, onAnalyze }: { data: CountryLeaders; onAnalyze: (symbol: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const { items, offsets, total, headerIndex } = useMemo(() => {
    const bySector = new Map<string, Leader[]>();
    for (const l of data.leaders) bySector.set(l.sector, [...(bySector.get(l.sector) ?? []), l]);
    const order = [...data.sectors.filter((s) => bySector.has(s)), ...[...bySector.keys()].filter((s) => !data.sectors.includes(s))];
    const items: Item[] = order.flatMap((sector) => {
      const group = bySector.get(sector)!.sort((a, b) => a.rank - b.rank);
      return [{ kind: "header", sector, count: group.length } as Item, ...group.map((leader) => ({ kind: "row", leader }) as Item)];
    });
    const offsets: number[] = [];
    let y = 0;
    for (const it of items) {
      offsets.push(y);
      y += it.kind === "header" ? HEADER_H : ROW_H;
    }
    const headerIndex = new Map(items.flatMap((it, i) => (it.kind === "header" ? [[it.sector, i] as const] : [])));
    return { items, offsets, total: y, headerIndex };
  }, [data]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Binary search for the first item intersecting the (overscanned) viewport.
  const top = Math.max(0, scrollTop - OVERSCAN_PX);
  const bottom = scrollTop + viewport + OVERSCAN_PX;
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  const visible: number[] = [];
  for (let i = lo; i < items.length && offsets[i] < bottom; i++) visible.push(i);

  // The sector whose section the top of the viewport is in — shown as a sticky header.
  let current: string | null = null;
  for (let i = lo; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "header") {
      current = it.sector;
      break;
    }
  }
  const sectors = [...headerIndex.keys()];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-1 border-b border-white/5 px-4 py-2.5" role="group" aria-label="Jump to sector">
        {sectors.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => scroller.current?.scrollTo({ top: offsets[headerIndex.get(s)!], behavior: "smooth" })}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ring-1 transition ${
              current === s ? "bg-cyan-400/20 text-cyan-100 ring-cyan-300/50" : "text-slate-400 ring-white/10 hover:text-slate-200"
            }`}
          >
            {s} <span className="text-cyan-300/70">{(items[headerIndex.get(s)!] as Extract<Item, { kind: "header" }>).count}</span>
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {current && scrollTop > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
            <SectorHeader sector={current} count={(items[headerIndex.get(current)!] as Extract<Item, { kind: "header" }>).count} />
          </div>
        )}
        <div
          ref={scroller}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="absolute inset-0 overflow-y-auto overscroll-contain"
          role="list"
          aria-label={`${data.leaders.length} listings grouped by sector`}
        >
          <div style={{ height: total, position: "relative" }}>
            {visible.map((i) => {
              const it = items[i];
              return (
                <div
                  key={it.kind === "header" ? `h-${it.sector}` : it.leader.symbol}
                  role={it.kind === "row" ? "listitem" : "presentation"}
                  // Rows sit 6px in from the edges so their hover scale and glow aren't clipped by the scroller.
                  style={{
                    position: "absolute",
                    top: offsets[i],
                    left: it.kind === "header" ? 0 : 6,
                    right: it.kind === "header" ? 0 : 6,
                    height: it.kind === "header" ? HEADER_H : ROW_H,
                  }}
                >
                  {it.kind === "header" ? (
                    <SectorHeader sector={it.sector} count={it.count} />
                  ) : (
                    <StockRow leader={it.leader} onAnalyze={onAnalyze} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectorHeader({ sector, count }: { sector: string; count: number }) {
  return (
    <div className="flex h-[34px] items-center justify-between border-b border-cyan-400/15 bg-[#0a1324] px-4">
      <span className="text-[10.5px] font-bold tracking-[0.22em] text-cyan-200 uppercase">{sector}</span>
      <span className="font-mono text-[10px] text-slate-500">{count}</span>
    </div>
  );
}

function CountryPanel({
  country,
  covered,
  onClose,
  onAnalyze,
}: {
  country: CountryProps;
  covered: boolean;
  onClose: () => void;
  onAnalyze: (symbol: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const state = useFetch((signal) => (covered ? fetchCountryLeaders(country.iso, signal) : Promise.resolve<CountryLeaders | null>(null)));
  const [filter, setFilter] = useState("");
  const loaded = state.status === "success" ? state.data : null;
  // Long lists (every US-listed SEC filer) filter by ticker or name as you type.
  const shown = useMemo(() => {
    const q = filter.trim().toUpperCase();
    if (!loaded || !q) return loaded;
    return { ...loaded, leaders: loaded.leaders.filter((l) => l.symbol.toUpperCase().startsWith(q) || l.name.toUpperCase().includes(q)) };
  }, [loaded, filter]);
  return (
    <motion.aside
      role="dialog"
      aria-label={`Top stocks: ${country.name}`}
      initial={reduceMotion ? { opacity: 0 } : { x: "100%", opacity: 0.6 }}
      animate={{ x: 0, opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { x: "100%", opacity: 0.6, transition: { duration: 0.22, ease: "easeIn" } }}
      transition={{ type: "spring", stiffness: 260, damping: 32 }}
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[460px] flex-col border-l border-cyan-400/25 bg-[#070c17]/[0.97] shadow-[-24px_0_60px_-20px_rgba(34,211,238,0.25)] backdrop-blur-xl"
    >
      <div className="relative border-b border-white/5 px-5 pt-5 pb-4">
        <div className="text-[10px] font-semibold tracking-[0.3em] text-cyan-300/80 uppercase">Scout report · {country.continent}</div>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-3xl leading-none" aria-hidden>
            {flag(country.iso)}
          </span>
          <h3 className="text-xl font-bold tracking-tight text-white">{country.name}</h3>
        </div>
        {state.status === "success" && state.data && (
          <p className="mt-2 font-mono text-[10.5px] text-slate-500">
            {state.data.leaders.length.toLocaleString()} listings · ranked by live market cap · live quotes · → adds a company to the comparison
          </p>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scout report"
          className="absolute top-4 right-4 grid size-7 place-items-center rounded-md text-slate-400 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
        >
          ×
        </button>
      </div>
      {!covered ? (
        <p className="m-4 rounded-lg border border-dashed border-white/10 p-4 text-[13px] text-slate-400">
          No scouted listings for {country.name} yet. Covered markets carry a cyan marker on the map.
        </p>
      ) : state.status === "loading" ? (
        <ul className="space-y-px p-4" aria-busy="true">
          {country.iso === "US" && (
            <li className="pb-2 text-[11.5px] text-slate-400">Pricing every US-listed SEC filer — the first load can take up to a minute.</li>
          )}
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="h-14 animate-pulse rounded bg-white/[0.04]" />
          ))}
        </ul>
      ) : state.status === "error" ? (
        <p className="m-4 text-[13px] text-rose-300">{state.error}</p>
      ) : (
        shown && (
          <>
            {loaded && loaded.leaders.length > 60 && (
              <div className="border-b border-white/5 px-4 py-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Filter ${loaded.leaders.length.toLocaleString()} companies by name or ticker`}
                  aria-label="Filter companies"
                  className="h-8 w-full rounded-md bg-black/40 px-3 font-mono text-[12px] text-white ring-1 ring-white/10 outline-none ring-inset placeholder:font-sans placeholder:text-slate-500 focus:ring-cyan-400/60"
                />
              </div>
            )}
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-2 text-[9.5px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
              <span>Company · ticker · price</span>
              <span className="pr-1">Add to comparison →</span>
            </div>
            {shown.leaders.length === 0 ? (
              <p className="p-4 text-[12.5px] text-slate-400">No company matches “{filter}”.</p>
            ) : (
              <SectorList key={filter} data={shown} onAnalyze={onAnalyze} />
            )}
          </>
        )
      )}
    </motion.aside>
  );
}

// ---------------------------------------------------------------- map

export function EquityDiscovery({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const reduceMotion = useReducedMotion();
  const world = useWorld();
  const coverage = useFetch((signal) => fetchDiscoveryCountries(signal));
  const covered = coverage.status === "success" ? coverage.data.countries : {};

  const [region, setRegion] = useState<RegionKey | null>(null);
  const [hovered, setHovered] = useState<CountryProps | null>(null);
  const [selected, setSelected] = useState<CountryProps | null>(null);
  const [settledK, setSettledK] = useState(1); // zoom level once the camera stops — labels are sized to it
  const group = useRef<SVGGElement>(null);
  const camera = useRef<Camera>(WORLD);

  const target = useMemo<Camera>(() => {
    if (world.status !== "success" || !region) return WORLD;
    const r = REGIONS.find((x) => x.key === region)!;
    return cameraFor((p) => world.projection(p), r.bounds);
  }, [world, region]);

  // Tween the camera (one SVG transform) from wherever it is to the target.
  useEffect(() => {
    const el = group.current;
    if (!el) return;
    const from = { ...camera.current };
    const apply = (c: Camera) => {
      camera.current = c;
      el.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
    };
    if (reduceMotion) {
      apply(target); // no tween: the camera is already settled (see `k` below)
      return;
    }
    // Zoom in a log-linear way so scale changes feel even.
    const controls = animate(0, 1, {
      duration: 0.95,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (t) => {
        const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * t);
        apply({ k, x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t });
      },
      onComplete: () => setSettledK(target.k),
    });
    return () => controls.stop();
  }, [target, reduceMotion]);

  const goWorld = useCallback(() => {
    setSelected(null);
    setRegion(null);
  }, []);

  // Escape steps back (report → region → world). Listened for on the document because clicking an SVG
  // country doesn't move keyboard focus into the panel; ignored while the panel is hidden in another tab.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected && !region) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !root.current?.offsetParent) return;
      if (selected) setSelected(null);
      else goWorld();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, region, goWorld]);

  const regionCountries =
    world.status === "success" && region
      ? world.countries
          .map((c) => c.f.properties)
          .filter((p) => p.continent === region)
          .sort((a, b) => (covered[b.iso] ? 1 : 0) - (covered[a.iso] ? 1 : 0) || a.name.localeCompare(b.name))
      : [];
  const coveredInRegion = regionCountries.filter((p) => covered[p.iso]);
  const zoomed = region != null;
  const k = reduceMotion ? target.k : settledK;
  const showLabels = zoomed && Math.abs(k - target.k) < 1e-6;

  return (
    <section
      ref={root}
      aria-label="Equity Discovery scout map"
      className="relative overflow-hidden rounded-2xl bg-macropulse-obsidian text-slate-200 shadow-[0_30px_80px_-30px_rgba(8,145,178,0.45)] ring-1 ring-cyan-400/15"
    >
      {/* HUD backdrop: faint grid + vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(34,211,238,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.07) 1px, transparent 1px)",
          backgroundSize: "36px 36px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(2,4,10,0.85)_100%)]"
      />
      {(
        [
          "top-3 left-3 border-t border-l",
          "top-3 right-3 border-t border-r",
          "bottom-3 left-3 border-b border-l",
          "bottom-3 right-3 border-b border-r",
        ] as const
      ).map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute size-5 border-cyan-300/50 ${c}`} />
      ))}

      {/* Header */}
      <div className="relative flex flex-wrap items-end justify-between gap-4 px-6 pt-6">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.35em] text-cyan-300/80 uppercase">Scout network · global markets</div>
          <h2 className="mt-1 text-2xl font-black tracking-tight text-white uppercase italic">Equity Discovery</h2>
          <nav aria-label="Map location" className="mt-1 flex items-center gap-2 font-mono text-[11px] text-slate-400">
            <button
              type="button"
              onClick={goWorld}
              className={zoomed ? "text-cyan-300 hover:text-cyan-100" : "text-slate-300"}
              disabled={!zoomed}
            >
              WORLD
            </button>
            {region && (
              <>
                <span aria-hidden>›</span>
                <span className="text-slate-200 uppercase">{region}</span>
              </>
            )}
            {selected && (
              <>
                <span aria-hidden>›</span>
                <span className="text-slate-200 uppercase">{selected.name}</span>
              </>
            )}
          </nav>
        </div>
        <div className="flex gap-6 font-mono text-[11px] text-slate-400">
          <div>
            <div className="text-xl font-bold text-cyan-200 tabular-nums">{Object.keys(covered).length}</div>
            markets scouted
          </div>
          <div>
            <div className="text-xl font-bold text-cyan-200 tabular-nums">{Object.values(covered).reduce((a, b) => a + b, 0)}</div>
            listings tracked
          </div>
        </div>
      </div>

      {/* Region selector (also the keyboard route into the map) */}
      <div className="relative mt-4 flex flex-wrap gap-1.5 px-6" role="group" aria-label="Choose a region">
        {REGIONS.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => {
              setSelected(null);
              setRegion(r.key);
            }}
            aria-pressed={region === r.key}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold tracking-wider uppercase ring-1 transition ${
              region === r.key
                ? "bg-cyan-400 text-slate-950 ring-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.5)]"
                : "text-slate-300 ring-white/10 hover:bg-white/5 hover:ring-cyan-400/40"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Map */}
      <div className="relative mt-3 px-3 pb-3">
        {world.status === "loading" && <div className="aspect-[96/50] animate-pulse rounded-xl bg-white/[0.03]" />}
        {world.status === "error" && <p className="p-6 text-[13px] text-rose-300">{world.error}</p>}
        {world.status === "success" && (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full select-none"
            role="img"
            aria-label={region ? `Map of ${region}` : "World map by region"}
            onClick={(e) => e.target === e.currentTarget && zoomed && !selected && goWorld()}
          >
            <defs>
              <filter id="ed-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <g ref={group}>
              {world.countries.map(({ f, d }) => {
                const p = f.properties;
                const inRegion = !region || p.continent === region;
                const hoverContinent = !region && hovered?.continent === p.continent;
                const isHover = !!region && hovered?.iso === p.iso && inRegion;
                const isSelected = selected?.iso === p.iso;
                const isCovered = !!covered[p.iso];
                const fill = isSelected
                  ? "#00f0ff"
                  : isHover
                    ? "#0e7490"
                    : hoverContinent
                      ? "#164e63"
                      : !inRegion
                        ? "#0b111c"
                        : isCovered
                          ? "#12304a"
                          : "#0f1b2b";
                return (
                  <path
                    key={p.iso + p.name}
                    d={d}
                    fill={fill}
                    stroke={isSelected || isHover ? "#00f0ff" : region && inRegion ? "#1e3a52" : "#0a1422"}
                    strokeWidth={isSelected || isHover ? 1.4 : 0.6}
                    vectorEffect="non-scaling-stroke"
                    filter={isSelected ? "url(#ed-glow)" : undefined}
                    style={{ transition: "fill 0.3s var(--mp-ease)" }}
                    className={inRegion ? "cursor-pointer" : "pointer-events-none"}
                    onMouseEnter={() => setHovered(p)}
                    onMouseLeave={() => setHovered((h) => (h?.iso === p.iso ? null : h))}
                    onClick={() => {
                      if (!region) setRegion(p.continent as RegionKey);
                      else if (inRegion) setSelected(p);
                    }}
                  >
                    <title>{p.name}</title>
                  </path>
                );
              })}

              {/* Hover highlight, drawn above every country: the hovered country (region view) or continent
                  (world view) pops to 1.02× with a macropulse-cyan glow. Glow radius ÷ zoom keeps it constant on screen. */}
              {hovered && (
                <g
                  key={region ? `hc-${hovered.iso}` : `hr-${hovered.continent}`}
                  className="mp-country-hover pointer-events-none"
                  style={{ filter: `drop-shadow(0 0 ${6 / k}px rgba(0, 240, 255, 0.8))` }}
                >
                  {world.countries
                    .filter(({ f }) =>
                      region
                        ? f.properties.iso === hovered.iso && f.properties.continent === region
                        : f.properties.continent === hovered.continent,
                    )
                    .map(({ f, d }) => (
                      <path
                        key={f.properties.iso}
                        d={d}
                        fill={region ? "rgba(0, 240, 255, 0.22)" : "rgba(0, 240, 255, 0.10)"}
                        stroke="#00f0ff"
                        strokeWidth={region ? 1.6 : 0.8}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                </g>
              )}

              {/* Scout markers on covered markets */}
              {world.countries
                .filter(({ f }) => covered[f.properties.iso] && (!region || f.properties.continent === region))
                .map(({ f }) => {
                  const xy = world.projection([f.properties.lx, f.properties.ly]);
                  if (!xy) return null;
                  const r = (zoomed ? 3.2 : 2.2) / k;
                  return (
                    <g key={`m-${f.properties.iso}`} transform={`translate(${xy[0]} ${xy[1]})`} className="pointer-events-none">
                      {zoomed && !reduceMotion && (
                        <circle r={r} fill="none" stroke="#00f0ff" strokeWidth={1} vectorEffect="non-scaling-stroke" className="ed-pulse" />
                      )}
                      <circle r={r} fill="#00f0ff" filter="url(#ed-glow)" />
                    </g>
                  );
                })}

              {/* Region view: country labels sized to the settled zoom */}
              {showLabels &&
                placeLabels(
                  world.countries
                    .map(({ f }) => f.properties)
                    .filter((p) => p.continent === region && (covered[p.iso] || p.ml <= (k > 4 ? 4.5 : 3.5))),
                  (p) => world.projection([p.lx, p.ly]),
                  (p) => !!covered[p.iso],
                  k,
                ).map(({ p, x, y, size, isCovered }) => (
                  <motion.text
                    key={`l-${p.iso}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    fontSize={size}
                    letterSpacing={0.08 / k}
                    fill={isCovered ? "#e0f2fe" : "#64748b"}
                    stroke="#05080f"
                    strokeWidth={3 / k}
                    paintOrder="stroke"
                    className="pointer-events-none font-sans font-semibold uppercase"
                  >
                    {p.name}
                  </motion.text>
                ))}

              {/* World view: continent labels */}
              {!zoomed &&
                REGIONS.map((r) => {
                  const xy = world.projection(r.anchor as unknown as [number, number]);
                  if (!xy) return null;
                  return (
                    <text
                      key={`r-${r.key}`}
                      x={xy[0]}
                      y={xy[1]}
                      textAnchor="middle"
                      fontSize={13}
                      letterSpacing={3}
                      fill={hovered?.continent === r.key ? "#cffafe" : "#94a3b8"}
                      stroke="#05080f"
                      strokeWidth={3}
                      paintOrder="stroke"
                      className="pointer-events-none font-sans font-black uppercase italic transition-[fill]"
                    >
                      {r.label}
                    </text>
                  );
                })}
            </g>
          </svg>
        )}

        {/* Hover HUD */}
        <div className="pointer-events-none absolute bottom-6 left-6 min-w-44 rounded-md border border-cyan-400/20 bg-[#070c17]/85 px-3 py-2 backdrop-blur">
          {hovered ? (
            <>
              <div className="text-[9.5px] tracking-[0.25em] text-cyan-300/80 uppercase">{region ? hovered.continent : "Region"}</div>
              <div className="text-[13px] font-semibold text-white">
                {region ? `${flag(hovered.iso)} ${hovered.name}` : hovered.continent}
              </div>
              <div className="font-mono text-[10.5px] text-slate-400">
                {region
                  ? covered[hovered.iso]
                    ? `${covered[hovered.iso]} listings scouted — click to open`
                    : "No coverage yet"
                  : `${Object.entries(covered).filter(([iso]) => world.status === "success" && world.countries.some((c) => c.f.properties.iso === iso && c.f.properties.continent === hovered.continent)).length} markets — click to zoom`}
              </div>
            </>
          ) : (
            <div className="font-mono text-[10.5px] text-slate-400">
              {region ? "Hover a country · click to scout" : "Hover a region · click to zoom"}
            </div>
          )}
        </div>
      </div>

      {/* Region roster: covered markets as buttons (keyboard access to countries) */}
      <AnimatePresence>
        {region && coveredInRegion.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="relative flex flex-wrap gap-1.5 border-t border-white/5 px-6 py-4"
            role="group"
            aria-label={`Scouted markets in ${region}`}
          >
            {coveredInRegion.map((p) => (
              <button
                key={p.iso}
                type="button"
                onClick={() => setSelected(p)}
                aria-pressed={selected?.iso === p.iso}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] ring-1 transition ${
                  selected?.iso === p.iso
                    ? "bg-cyan-400/20 text-cyan-100 ring-cyan-300/60"
                    : "text-slate-300 ring-white/10 hover:bg-white/5 hover:ring-cyan-400/40"
                }`}
              >
                <span aria-hidden>{flag(p.iso)}</span>
                {p.name}
                <span className="font-mono text-[10px] text-cyan-300/80">{covered[p.iso]}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Spans the whole Discovery panel (not just the map) so long lists get room to scroll. */}
      <AnimatePresence>
        {selected && (
          <CountryPanel
            key={selected.iso}
            country={selected}
            covered={!!covered[selected.iso]}
            onClose={() => setSelected(null)}
            onAnalyze={onAnalyze}
          />
        )}
      </AnimatePresence>
    </section>
  );
}
