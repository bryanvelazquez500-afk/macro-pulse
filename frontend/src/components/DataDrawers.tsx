"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ReactNode, useEffect, useRef, useState } from "react";

import { TagMapping } from "@/components/TagMapping";
import { flow } from "@/lib/motion";
import { CompanyEntry, symbolOf } from "@/lib/comparisonStore";

type DrawerKey = "lineage" | "filings";

const DRAWERS: Record<DrawerKey, { icon: ReactNode; label: string; short: string; width: string }> = {
  lineage: { icon: <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="4" cy="4" r="1.75" /><circle cx="4" cy="12" r="1.75" /><circle cx="12" cy="8" r="1.75" /><path d="M5.75 4h1.5a2 2 0 0 1 2 2v0a2 2 0 0 0 1 1.73M5.75 12h1.5a2 2 0 0 0 2-2v0a2 2 0 0 1 1-1.73" /></svg>, label: "View data lineage", short: "Lineage", width: "w-[min(64rem,calc(100vw-2rem))]" },
  filings: { icon: <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 1.75h5.25L12.5 5v9.25H4z" /><path d="M9 1.75V5.25h3.5M6.25 8.25h4M6.25 11h4" /></svg>, label: "SEC filings history", short: "Filings", width: "w-[min(36rem,calc(100vw-2rem))]" },
};

function LineageBody({ entry }: { entry: CompanyEntry }) {
  const f = entry.financials!;
  return (
    <>
      <p className="mb-4 text-[12px] text-ink-3">
        Every number in the matrix traces back to one of these tags: <span className="text-ink">■ in use</span> for this company,{" "}
        <span className="text-ink-3">□ available</span> but not reported. {f.accounting_standard} · {f.currency} ·{" "}
        {f.source === "sec" ? "SEC EDGAR CompanyFacts" : "Financial Modeling Prep"} · {f.period_type} periods.
      </p>
      <TagMapping tagMap={f.tag_map} periods={f.periods} bare />
    </>
  );
}

function FilingsBody({ entry }: { entry: CompanyEntry }) {
  const filings = entry.profile?.recent_filings ?? [];
  if (filings.length === 0) {
    return (
      <p className="text-[13px] text-ink-3">
        {entry.profile?.source === "fmp" ? `${symbolOf(entry)} isn't registered with the SEC, so there's no EDGAR filing history.` : "No recent filings."}
      </p>
    );
  }
  return (
    <table className="w-full text-[14px]">
      <thead>
        <tr className="eyebrow text-left">
          <th className="pb-2 font-medium">Form</th>
          <th className="pb-2 font-medium">Filed</th>
          <th className="pb-2 font-medium">Period</th>
          <th className="pb-2 text-right font-medium">
            <span className="sr-only">Link</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {filings.map((f) => (
          <tr key={f.accession_number} className="transition-colors duration-[var(--dur-1)] hover:bg-subtle">
            <td className="py-2 pr-4 font-mono text-ink">{f.form}</td>
            <td className="py-2 pr-4 font-mono text-ink-3">{f.filing_date}</td>
            <td className="py-2 pr-4 font-mono text-ink-3">{f.report_date ?? "—"}</td>
            <td className="py-2 text-right">
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="link text-xs" title={f.accession_number}>
                View
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Header buttons that open the focused company's data lineage (raw tag map) and SEC filing history
 * in overlay drawers. One drawer at a time; Escape or a click outside closes it and returns focus.
 */
export function DataDrawers({ entry }: { entry: CompanyEntry | null }) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState<DrawerKey | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<DrawerKey, HTMLButtonElement | null>>>({});
  const ready = entry?.status === "ready" && !!entry.financials;

  useEffect(() => {
    if (!open) return;
    const close = (returnFocus: boolean) => {
      if (returnFocus) buttons.current[open]?.focus();
      setOpen(null);
    };
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const body: Record<DrawerKey, () => ReactNode> = {
    lineage: () => <LineageBody entry={entry!} />,
    filings: () => <FilingsBody entry={entry!} />,
  };

  return (
    <div ref={root} className="relative flex gap-2">
      {(Object.keys(DRAWERS) as DrawerKey[]).map((key) => {
        const d = DRAWERS[key];
        const isOpen = open === key;
        return (
          <motion.button
            key={key}
            ref={(el) => {
              buttons.current[key] = el;
            }}
            type="button"
            disabled={!ready}
            onClick={() => setOpen(isOpen ? null : key)}
            aria-expanded={isOpen}
            aria-controls={`drawer-${key}`}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            title={ready ? `${d.label} — ${entry && symbolOf(entry)}` : "Load a company first"}
            className="btn-secondary btn-sm"
          >
            {d.icon}
            <span className="hidden 2xl:inline">{d.label}</span>
            <span className="max-sm:sr-only 2xl:hidden">{d.short}</span>
            <motion.svg aria-hidden viewBox="0 0 12 12" className="size-3 text-ink-3" animate={{ rotate: isOpen ? 180 : 0 }} transition={flow(2)}>
              <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </motion.svg>
          </motion.button>
        );
      })}

      <AnimatePresence>
        {open && ready && (
          <motion.div
            key={open}
            id={`drawer-${open}`}
            role="dialog"
            aria-label={`${DRAWERS[open].label} — ${symbolOf(entry!)}`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: flow(1) }}
            transition={flow(3)}
            className={`absolute top-[calc(100%+0.6rem)] right-0 z-40 max-h-[70vh] overflow-y-auto rounded-md border border-line bg-panel shadow-2 ${DRAWERS[open].width}`}
          >
            <div className="sticky top-0 flex items-center justify-between gap-4 border-b border-line bg-panel px-5 py-3">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <span className="text-spruce">{DRAWERS[open].icon}</span>
                {DRAWERS[open].label} · <span className="font-mono">{symbolOf(entry!)}</span>
                <span className="text-[13px] font-normal text-ink-3">{entry!.profile?.name}</span>
              </h2>
              <button
                type="button"
                onClick={() => {
                  buttons.current[open]?.focus();
                  setOpen(null);
                }}
                aria-label="Close"
                className="grid size-8 place-items-center rounded-full text-[18px] text-ink-3 hover:bg-subtle hover:text-ink"
              >
                ×
              </button>
            </div>
            <div className="p-5">{body[open]()}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
