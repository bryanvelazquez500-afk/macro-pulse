"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { flow } from "@/lib/motion";
import { usePortfolio } from "@/lib/portfolioStore";

/** The watchlist as a header menu, so it's one click away without taking a column of the page. */
export function WatchlistMenu({ activeTicker, onSelect }: { activeTicker: string | null; onSelect: (ticker: string) => void }) {
  const [open, setOpen] = useState(false);
  const { portfolio } = usePortfolio();
  const reduceMotion = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="btn-secondary btn-sm"
      >
        <svg viewBox="0 0 16 16" className="size-4 text-brass" fill="currentColor" aria-hidden>
          <path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" />
        </svg>
        <span className="max-sm:sr-only">Watchlist</span>
        <span className="rounded-full bg-subtle px-1.5 text-[12px] font-semibold text-ink-3">{portfolio.watchlist.length}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Watchlist"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: flow(1) }}
            transition={flow(2)}
            className="absolute top-[calc(100%+0.6rem)] right-0 z-40 w-64 rounded-md border border-line bg-panel p-3 shadow-2"
          >
            <WatchlistSidebar
              activeTicker={activeTicker}
              onSelect={(t) => {
                onSelect(t);
                setOpen(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
