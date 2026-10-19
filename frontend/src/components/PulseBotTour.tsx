"use client";

/**
 * PulseBotTour — an on-demand guided tour. Mounted only while `open` (the yellow #help-tour-trigger
 * button), so nothing runs and no listeners exist until the user asks for it.
 *
 * Each step targets an element by id. The page scrolls it into view, a blurred dark mask covers
 * everything except a cut-out over the target (clip-path with an even-odd hole), and Pulse-Bot glides
 * beside it with a one-sentence explanation. Space (or →) advances, ← goes back, Esc exits; on the last
 * step a glowing Exit button appears and Space closes the tour. Steps whose target isn't on the page
 * (e.g. no company loaded yet) are skipped.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface TourStep {
  target: string; // element id
  title: string;
  text: string; // one friendly sentence
  /** Analysis tab to open for this step (its content only exists once the tab is shown). */
  view?: "matrix" | "discovery" | "supply";
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: "tour-search",
    title: "Equities Hub",
    text: "Type any ticker or CIK here — US stocks or global listings like ASML.AS — and flip between Annual and Quarterly filings.",
  },
  {
    target: "tour-matrix",
    view: "matrix",
    title: "Comparison Matrix",
    text: "Up to three companies sit side by side here, every line item straight from their filings with color-coded year-over-year swings.",
  },
  {
    target: "horizontal-analysis",
    view: "matrix",
    title: "Horizontal Analysis",
    text: "Expand a company to watch every line item change over 5–10 years as % change, an index or raw values — click any row to chart it.",
  },
  {
    target: "tour-tabs",
    title: "Equity Discovery Map",
    text: "Switch to the Discovery tab to scout world markets on a map, ranked by live market cap, and send any stock here with its arrow.",
  },
  {
    target: "tour-supply",
    view: "supply",
    title: "Supply Chain Network",
    text: "Type any ticker to map who supplies and buys from it, straight from SEC filings — click a bubble to read what the filings say about each other.",
  },
  {
    target: "tour-dcf",
    title: "DCF Valuation Panel",
    text: "This calculator values the focused company with a two-stage DCF — tweak growth, years and discount rate and the fair value updates instantly.",
  },
  {
    target: "tour-ivs",
    title: "Intrinsic Valuation Station",
    text: "Cross-check with CAPM, the Dividend Discount Model and Graham's formula, and sync the live 10-year Treasury with one click.",
  },
  {
    target: "tour-news",
    title: "Related News",
    text: "Live headlines for the focused company glide across this tape — hover to pause it and click any story to read it.",
  },
  {
    target: "tour-drawers",
    title: "Data Lineage & SEC Filings",
    text: "Open these drawers to see exactly which SEC tags fed each number and to jump straight to the original 10-K and 10-Q filings.",
  },
  {
    target: "tour-watchlist",
    title: "Watchlist",
    text: "Keep tickers you're tracking here and click one to drop it straight into the comparison.",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 8; // spotlight margin around the target
const BOT_W = 320;
const BOT_H = 196; // approximate, for placement
const GAP = 18;

/** Bottom edge of the sticky header, unless the target lives inside the header itself. */
function headerFloor(el: HTMLElement): number {
  const header = document.querySelector("header");
  if (!header || header.contains(el)) return 8;
  return header.getBoundingClientRect().bottom + 6;
}

function readRect(id: string): Rect | null {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  // Keep huge targets (the matrix) inside the viewport, and below the sticky header, so the hole
  // never shows the header through it and the bot stays on screen.
  const top = Math.max(r.top - PAD, headerFloor(el));
  const bottom = Math.min(r.bottom + PAD, window.innerHeight - 8);
  return { top, left: r.left - PAD, width: r.width + PAD * 2, height: Math.max(bottom - top, 40) };
}

/** Beside the target if it fits (right, then left), else below or above; always inside the viewport. */
function placeBot(rect: Rect): { x: number; y: number; side: "left" | "right" | "top" | "bottom" } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampY = (y: number) => Math.min(Math.max(y, 12), vh - BOT_H - 12);
  const clampX = (x: number) => Math.min(Math.max(x, 12), vw - BOT_W - 12);
  const midY = rect.top + Math.min(rect.height, vh) / 2 - BOT_H / 2;
  if (rect.left + rect.width + GAP + BOT_W <= vw - 12) return { x: rect.left + rect.width + GAP, y: clampY(midY), side: "left" };
  if (rect.left - GAP - BOT_W >= 12) return { x: rect.left - GAP - BOT_W, y: clampY(midY), side: "right" };
  const midX = clampX(rect.left + rect.width / 2 - BOT_W / 2);
  if (rect.top + rect.height + GAP + BOT_H <= vh - 12) return { x: midX, y: rect.top + rect.height + GAP, side: "top" };
  if (rect.top - GAP - BOT_H >= 12) return { x: midX, y: rect.top - GAP - BOT_H, side: "bottom" };
  // Target fills the screen (the matrix on a small window): float over its lower-right corner.
  return { x: clampX(vw - BOT_W - 24), y: clampY(vh - BOT_H - 24), side: "left" };
}

/** Full-screen polygon with a rectangular hole (even-odd), animatable as one string. */
function maskPath(r: Rect): string {
  const [x0, y0, x1, y1] = [r.left, r.top, r.left + r.width, r.top + r.height].map((v) => `${v.toFixed(1)}px`);
  return `polygon(evenodd, 0px 0px, 100vw 0px, 100vw 100vh, 0px 100vh, 0px 0px, ${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0})`;
}

function Robot() {
  return (
    <div className="pulsebot-levitate relative size-14 shrink-0">
      <span aria-hidden className="pulsebot-ring absolute inset-0 rounded-2xl" />
      <svg viewBox="0 0 56 56" className="relative size-14" aria-hidden>
        <line x1="28" y1="6" x2="28" y2="13" stroke="#ffb700" strokeWidth="2" strokeLinecap="round" />
        <circle cx="28" cy="5" r="3" fill="#ffb700" className="pulsebot-antenna" />
        <rect x="9" y="13" width="38" height="30" rx="10" fill="rgba(18,20,24,0.9)" stroke="#ffb700" strokeWidth="2" />
        <rect x="15" y="20" width="26" height="14" rx="7" fill="#0a0b0d" />
        <circle cx="22" cy="27" r="3" fill="#00f0ff" className="pulsebot-eye" />
        <circle cx="34" cy="27" r="3" fill="#00f0ff" className="pulsebot-eye" />
        <path d="M23 38 Q28 41 33 38" stroke="#ffb700" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <rect x="5" y="24" width="4" height="9" rx="2" fill="#ffb700" />
        <rect x="47" y="24" width="4" height="9" rx="2" fill="#ffb700" />
        <rect x="19" y="45" width="18" height="6" rx="3" fill="rgba(255,183,0,0.35)" />
      </svg>
    </div>
  );
}

export function PulseBotTour({ onClose, onView }: { onClose: () => void; onView?: (view: NonNullable<TourStep["view"]>) => void }) {
  const reduceMotion = useReducedMotion();
  // Only steps whose target exists right now (e.g. horizontal analysis needs a loaded company).
  // Steps whose target is on the page, plus tab steps (their content appears once the tab opens).
  const [steps] = useState(() => TOUR_STEPS.filter((s) => (s.view && s.view !== "matrix") || document.getElementById(s.target)));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });
  const step = steps[index];
  const last = index === steps.length - 1;

  const next = useCallback(() => (last ? onClose() : setIndex((i) => i + 1)), [last, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Bring the target into view, then follow it (scrolling, resizing, layout shifts) every frame.
  useLayoutEffect(() => {
    if (!step) return;
    if (step.view) onViewRef.current?.(step.view); // open the step's tab first
    const behavior = reduceMotion ? "auto" : "smooth";
    const bringIntoView = (el: HTMLElement) => {
      // Tall features scroll to their top edge (scroll-margin keeps it clear of the header); others center.
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
      if (tall && !el.closest("aside") && !document.querySelector("header")?.contains(el)) {
        // Page-level tall feature (the matrix): put its top edge just under the sticky header.
        const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - headerBottom - 16, behavior });
      } else {
        el.scrollIntoView({ behavior, block: tall ? "start" : "center", inline: "nearest" });
      }
    };
    let frame = 0;
    let prev = "";
    let scrolled = false;
    const tick = () => {
      // A tab's content mounts a frame or two after the switch: scroll once it exists.
      const el = document.getElementById(step.target);
      if (el && !scrolled && el.getBoundingClientRect().height > 0) {
        scrolled = true;
        bringIntoView(el);
      }
      const r = readRect(step.target);
      const key = r ? `${Math.round(r.top)}:${Math.round(r.left)}:${Math.round(r.width)}:${Math.round(r.height)}` : "";
      if (key !== prev) {
        prev = key;
        setRect(r);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [step, reduceMotion]);

  // Listeners exist only while the tour is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault(); // Space would otherwise scroll the page
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, back, onClose]);

  const bot = useMemo(() => (rect ? placeBot(rect) : null), [rect]);
  // Move focus into the bot once it appears (it renders after the first measurement).
  const shown = bot != null;
  useEffect(() => {
    if (shown) card.current?.focus({ preventScroll: true });
  }, [shown]);
  const glide = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 140, damping: 22, mass: 0.9 };

  // Nothing to show (every target missing): close straight away.
  useEffect(() => {
    if (!step) onClose();
  }, [step, onClose]);
  if (!step) return null;

  return (
    <div className="fixed inset-0 z-[90]" role="presentation">
      {/* Mask: blurred, dark, with a hole over the active feature. Clicking it does nothing (no accidental exit). */}
      <motion.div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, clipPath: rect ? maskPath(rect) : "none" }}
        exit={{ opacity: 0 }}
        transition={{ opacity: { duration: 0.25 }, clipPath: glide }}
      />
      {/* Spotlight ring */}
      {rect && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute rounded-xl ring-2 ring-macropulse-neon-amber shadow-[0_0_0_1px_rgba(255,183,0,0.3),0_0_28px_rgba(255,183,0,0.45)]"
          initial={false}
          animate={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          transition={glide}
        />
      )}

      {/* Pulse-Bot */}
      {bot && (
        <motion.div
          ref={card}
          role="dialog"
          aria-modal="true"
          aria-label={`Guided tour, step ${index + 1} of ${steps.length}: ${step.title}`}
          tabIndex={-1}
          className="absolute outline-none"
          style={{ width: BOT_W }}
          initial={reduceMotion ? { opacity: 0, x: bot.x, y: bot.y } : { opacity: 0, scale: 0.85, x: bot.x, y: bot.y + 20 }}
          animate={{ opacity: 1, scale: 1, x: bot.x, y: bot.y }}
          transition={glide}
        >
          {/* Pointer toward the feature */}
          <span
            aria-hidden
            className={`absolute size-3.5 rotate-45 border-macropulse-neon-amber/60 bg-[#14161b] ${
              bot.side === "left"
                ? "top-12 -left-[7px] border-b border-l"
                : bot.side === "right"
                  ? "top-12 -right-[7px] border-t border-r"
                  : bot.side === "top"
                    ? "-top-[7px] left-1/2 border-t border-l"
                    : "-bottom-[7px] left-1/2 border-r border-b"
            }`}
          />
          <div className="rounded-2xl border border-macropulse-neon-amber/40 bg-[#14161b]/85 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <div className="flex gap-3">
              <Robot />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold tracking-[0.16em] text-macropulse-neon-amber uppercase">Pulse-Bot</span>
                  <span className="font-mono text-[10.5px] text-ink-4">
                    {index + 1}/{steps.length}
                  </span>
                </div>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={step.target}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.18 }}
                    aria-live="polite"
                  >
                    <h3 className="mt-1 text-[14px] font-semibold text-white">{step.title}</h3>
                    <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{step.text}</p>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* Progress */}
            <div className="mt-3 flex gap-1" aria-hidden>
              {steps.map((s, i) => (
                <span key={s.target} className={`h-1 flex-1 rounded-full transition-colors ${i <= index ? "bg-macropulse-neon-amber" : "bg-white/10"}`} />
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={back}
                disabled={index === 0}
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-3 hover:text-ink disabled:opacity-30"
              >
                ← Back
              </button>
              {last ? (
                <motion.button
                  type="button"
                  onClick={onClose}
                  initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="pulsebot-exit rounded-lg bg-macropulse-neon-green px-3.5 py-1.5 text-[12px] font-bold text-black"
                >
                  Exit tour ✓
                </motion.button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  className="flex items-center gap-2 rounded-lg bg-macropulse-neon-amber/15 px-3 py-1.5 text-[12px] font-semibold text-macropulse-neon-amber ring-1 ring-macropulse-neon-amber/40 hover:bg-macropulse-neon-amber/25"
                >
                  Next
                  <kbd className="rounded border border-macropulse-neon-amber/40 px-1.5 font-mono text-[10px]">Space</kbd>
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] text-ink-4">Space to continue · ← back · Esc to exit</p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
