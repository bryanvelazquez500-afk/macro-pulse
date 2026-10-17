"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shown wherever data needs an API key the site doesn't have. Clicking it explains — in plain terms —
 * that the information is unavailable at the moment. The explanation renders in a portal so it isn't
 * clipped by scrolling lists, the matrix or sliding panels.
 */
export function UnavailableButton({
  subject,
  compact = false,
  open: controlledOpen,
  onOpenChange,
}: {
  /** What's unavailable, e.g. "Siemens" — used in the explanation. */
  subject: string;
  compact?: boolean;
  /** Optional control, so a parent (e.g. a whole clickable row) can open the explanation. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const setOpenRef = useRef(setOpen);
  useEffect(() => {
    setOpenRef.current = setOpen;
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  // Place the explanation under the button, kept inside the viewport.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      const r = button.current!.getBoundingClientRect();
      const width = 260;
      setPos({ top: r.bottom + 8, left: Math.max(12, Math.min(window.innerWidth - width - 12, r.right - width)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenRef.current(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      // Clicks on the button itself (or the row that controls it) toggle via their own handlers.
      if (!popover.current?.contains(t) && !button.current?.parentElement?.contains(t)) setOpenRef.current(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={id}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md font-semibold text-rose-200 ring-1 ring-rose-400/40 ring-inset transition hover:bg-rose-500/15 hover:text-rose-100 focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:outline-none ${
          compact ? "px-2 py-1 text-[10.5px]" : "px-2.5 py-1.5 text-[12px]"
        } bg-rose-500/10`}
      >
        <span aria-hidden>⚠</span>
        Info unavailable
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={popover}
                id={id}
                role="dialog"
                aria-label="Information unavailable"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                style={{ position: "fixed", top: pos.top, left: pos.left, width: 260 }}
                className="z-[100] rounded-lg border border-white/10 bg-[#121418] p-3.5 text-left shadow-2xl shadow-black/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13px] font-semibold text-white">Info unavailable</p>
                  <button
                    type="button"
                    onClick={() => setOpenRef.current(false)}
                    aria-label="Close"
                    className="-mt-0.5 rounded px-1 text-slate-400 hover:bg-white/10 hover:text-white"
                  >
                    ×
                  </button>
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-300">
                  Financial data for <span className="font-medium text-white">{subject}</span> is unavailable at the moment. Please check
                  back later.
                </p>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
