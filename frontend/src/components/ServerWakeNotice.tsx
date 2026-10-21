"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

import { API_URL } from "@/lib/api";

/**
 * The free API host sleeps after idle spells and takes up to a minute to wake. If it hasn't answered
 * within a few seconds, say so, instead of leaving an empty page that looks broken.
 */
export function ServerWakeNotice() {
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let done = false;
    const timer = setTimeout(() => !done && setWaking(true), 3000);
    const controller = new AbortController();
    const ping = async () => {
      for (let attempt = 0; attempt < 12 && !done; attempt++) {
        try {
          const res = await fetch(`${API_URL}/api/health`, { signal: controller.signal, cache: "no-store" });
          if (res.ok) break;
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      done = true;
      clearTimeout(timer);
      setWaking(false);
    };
    ping();
    return () => {
      done = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <AnimatePresence>
      {waking && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="fixed top-28 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-line bg-panel px-4 py-2 text-[13px] text-ink-2 shadow-2"
        >
          <span className="mp-live-dot size-2 rounded-full bg-brass" aria-hidden />
          Waking up the data server — this can take up to a minute after a quiet spell.
        </motion.div>
      )}
    </AnimatePresence>
  );
}
