"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { fetchPeers } from "@/lib/api";
import { CompanyEntry, MAX_COMPARE } from "@/lib/comparisonStore";
import { flow } from "@/lib/motion";
import { useFetch } from "@/lib/useFetch";

/**
 * Industry peers of the focused company as clickable pills. Each pill shares a layoutId
 * with the matrix column header (`company-<TICKER>`), so clicking one makes it fly into the
 * new column while the column itself slides in.
 *
 * When the matrix is full the pills stay clickable (aria-disabled, dimmed): the store rejects
 * the add without changing entries and raises a warning toast, so no layout animation starts.
 * Peers already in the comparison show as "added" (mint, check mark, aria-pressed).
 */
export function PeerPills({ focusId, entries, onAdd }: { focusId: string; entries: CompanyEntry[]; onAdd: (ticker: string) => void }) {
  const state = useFetch((signal) => fetchPeers(focusId, signal));
  const reduceMotion = useReducedMotion();

  if (state.status !== "success" || !state.data.group) return null;
  const { group, sic, sic_description, ticker } = state.data;

  const inComparison = new Set(entries.flatMap((e) => [e.id, ...(e.profile?.tickers ?? [])]));
  // Peers already in the comparison stay listed as "added" (mint, checked) so the set reads as a whole.
  const peers = state.data.peers;
  const full = entries.length >= MAX_COMPARE;
  if (peers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="eyebrow mr-1" title={sic ? `SIC ${sic} · ${sic_description ?? ""}` : undefined}>
        {ticker ?? focusId} peers · {group}
      </span>
      <AnimatePresence mode="popLayout" initial>
        {peers.map((peer, i) => {
          const added = inComparison.has(peer.ticker);
          const blocked = full && !added;
          return (
            <motion.button
              key={peer.ticker}
              // Only an un-added pill shares its layoutId with the column header it flies into.
              layoutId={added ? undefined : `company-${peer.ticker}`}
              type="button"
              aria-pressed={added}
              aria-disabled={blocked}
              onClick={() => !added && onAdd(peer.ticker)}
              title={added ? `${peer.name} is in the comparison` : blocked ? `Remove a column to compare ${peer.name}` : `Add ${peer.name} to the comparison`}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: blocked ? 0.45 : 1, y: 0, transition: { ...flow(2), delay: reduceMotion ? 0 : i * 0.03 } }}
              exit={{ opacity: 0, transition: flow(1) }}
              transition={flow(2)}
              className={`peer-chip inline-flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-2.5 font-mono text-[12px] font-semibold ${
                added ? "border-transparent bg-mint text-mint-ink" : "border-line-strong bg-panel text-ink-2"
              }`}
            >
              {added ? (
                <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                  <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span aria-hidden className="text-ink-3">+</span>
              )}
              {peer.ticker}
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
