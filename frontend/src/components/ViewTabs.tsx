"use client";

import { motion, useReducedMotion } from "framer-motion";
import { KeyboardEvent, ReactNode, useId, useRef } from "react";

export interface ViewTab<K extends string> {
  key: K;
  label: string;
  /** Shorter label for narrow screens. */
  short: string;
  hint: string;
}

/**
 * Sub-tab bar (WAI-ARIA tabs pattern): arrow keys / Home / End move between tabs, and a shared
 * underline slides to the active one.
 */
export function ViewTabs<K extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: ViewTab<K>[];
  active: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const reduceMotion = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  function onKeyDown(e: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-black/30 p-1 ring-1 ring-line ring-inset">
      {tabs.map((tab, i) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={viewTabId(tab.key)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={viewPanelId(tab.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            title={tab.hint}
            className={`relative shrink-0 rounded-lg px-4 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-macropulse-cyan/60 ${
              selected ? "text-black" : "text-ink-3 hover:text-ink"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={`${id}-indicator`}
                className="absolute inset-0 rounded-lg bg-macropulse-cyan shadow-[0_0_16px_rgba(0,240,255,0.35)]"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <span className="relative text-[13px] font-semibold tracking-tight">
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.short}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const viewPanelId = (key: string) => `view-panel-${key}`;
export const viewTabId = (key: string) => `view-tab-${key}`;

/**
 * A tab panel that stays mounted while hidden, so inner state (matrix period offset, the scout map)
 * survives switching views; it fades in each time it becomes active.
 */
export function ViewPanel({ view, active, children }: { view: string; active: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      id={viewPanelId(view)}
      role="tabpanel"
      aria-labelledby={viewTabId(view)}
      tabIndex={0}
      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas"
      hidden={!active}
      initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: reduceMotion ? 0 : 6 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
