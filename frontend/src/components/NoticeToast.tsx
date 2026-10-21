"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

import { Notice } from "@/lib/comparisonStore";

const AUTO_DISMISS_MS = { info: 3500, warning: 5000 } as const;

/**
 * Floating notification for comparison notices (full matrix, duplicates, bad input).
 * Fixed-position so it never shifts the header or matrix layout; keyed by notice id so a
 * repeated warning re-plays its entrance instead of silently doing nothing.
 */
export function NoticeToast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS[notice.tone]);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  const warning = notice?.tone === "warning";

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6" aria-live={warning ? "assertive" : "polite"}>
      <AnimatePresence mode="wait">
        {notice && (
          <motion.div
            key={notice.id}
            role={warning ? "alert" : "status"}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, x: warning ? [0, -5, 5, -3, 3, 0] : 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 8, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 420, damping: 32, x: { duration: 0.35, delay: 0.1 } }}
            className={`pointer-events-auto flex max-w-md items-start gap-2.5 rounded-md border bg-panel py-2.5 pr-2.5 pl-3 text-[12.5px] shadow-lg shadow-ink/5 ${
              warning ? "border-caution/50 text-ink" : "border-line-strong text-ink-2"
            }`}
          >
            {warning ? (
              <svg viewBox="0 0 16 16" className="mt-px size-4 shrink-0 text-caution" fill="currentColor" aria-hidden>
                <path d="M8.9 1.6a1 1 0 0 0-1.8 0L.6 13.4A1 1 0 0 0 1.5 15h13a1 1 0 0 0 .9-1.6L8.9 1.6ZM8 5.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 5.5Zm0 7.25a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
              </svg>
            ) : (
              <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden />
            )}
            <span className="flex-1 leading-snug">
              {warning && <span className="sr-only">Warning: </span>}
              {notice.text}
            </span>
            <button type="button" onClick={onDismiss} className="-my-0.5 rounded px-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label="Dismiss notification">
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
