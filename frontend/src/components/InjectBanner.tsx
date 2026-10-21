"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";

import { flow } from "@/lib/motion";

/** Green confirmation banner for a ticker injected from the supply-chain web. */
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
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={flow(3)}
          className="fixed inset-x-0 top-28 z-[80] mx-auto w-fit rounded-full bg-gain px-5 py-2.5 text-[14px] font-bold text-on-surge-4 shadow-2"
        >
          ✓ {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
