"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { WatchlistSidebar } from "@/components/WatchlistSidebar";
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
        className={`mp-interactive inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium ring-1 ring-inset transition-colors ${
          open ? "bg-subtle text-ink ring-line-strong" : "text-ink-2 ring-line hover:text-ink"
        }`}
      >
        <span aria-hidden className="text-caution">★</span>
        Watchlist
        <span className="rounded-full bg-subtle px-1.5 font-mono text-[10.5px] text-ink-3">{portfolio.watchlist.length}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Watchlist"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="absolute top-[calc(100%+0.6rem)] right-0 z-40 w-64 rounded-xl bg-panel p-3 shadow-2xl ring-1 ring-line-strong"
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
