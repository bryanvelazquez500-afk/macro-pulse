"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { fetchPeers } from "@/lib/api";
import { CompanyEntry, MAX_COMPARE } from "@/lib/comparisonStore";
import { useFetch } from "@/lib/useFetch";

/**
 * Industry peers of the focused company as clickable pills. Each pill shares a layoutId
 * with the matrix column header (`company-<TICKER>`), so clicking one makes it fly into the
 * new column while the column itself slides in.
 *
 * When the matrix is full the pills stay clickable (aria-disabled, dimmed): the store rejects
 * the add without changing entries and raises a warning toast, so no layout animation starts.
 */
export function PeerPills({ focusId, entries, onAdd }: { focusId: string; entries: CompanyEntry[]; onAdd: (ticker: string) => void }) {
  const state = useFetch((signal) => fetchPeers(focusId, signal));
  const reduceMotion = useReducedMotion();

  if (state.status !== "success" || !state.data.group) return null;
  const { group, sic, sic_description, ticker } = state.data;

  const inComparison = new Set(entries.flatMap((e) => [e.id, ...(e.profile?.tickers ?? [])]));
  const peers = state.data.peers.filter((p) => !inComparison.has(p.ticker));
  const full = entries.length >= MAX_COMPARE;
  if (peers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="eyebrow mr-1" title={sic ? `SIC ${sic} · ${sic_description ?? ""}` : undefined}>
        {ticker ?? focusId} peers · {group}
      </span>
      <AnimatePresence mode="popLayout" initial>
        {peers.map((peer, i) => (
          <motion.button
            key={peer.ticker}
            layoutId={`company-${peer.ticker}`}
            type="button"
            aria-disabled={full}
            onClick={() => onAdd(peer.ticker)}
            title={full ? `Remove a column to compare ${peer.name}` : `Add ${peer.name} to the comparison`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.92, filter: "blur(4px)" }}
            animate={{ opacity: full ? 0.4 : 1, y: 0, scale: 1, filter: "blur(0px)", transition: { delay: reduceMotion ? 0 : i * 0.045 } }}
            exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.15 } }}
            // Same scale and curve as the global .mp-interactive hover; Framer owns this element's transform.
            whileHover={full || reduceMotion ? undefined : { scale: 1.02, transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] } }}
            whileTap={reduceMotion ? undefined : { scale: full ? 0.98 : 0.94 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="mp-interactive-glow group inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-panel py-1 pr-3 pl-2 font-mono text-[11.5px] text-ink-2 hover:border-macropulse-cyan/50 hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:hover:border-line-strong aria-disabled:hover:text-ink-2"
          >
            <span aria-hidden className="text-ink-4 transition-colors group-hover:text-ink group-aria-disabled:text-ink-4">
              +
            </span>
            {peer.ticker}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
