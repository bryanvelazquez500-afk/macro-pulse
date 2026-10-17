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
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
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
            className={`relative -mb-px px-3 pt-2 pb-3 text-left transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ink/30 ${
              selected ? "text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            <span className="eyebrow mr-2 align-middle text-ink-4">{String.fromCharCode(65 + i)}</span>
            <span className="align-middle text-[13px] font-medium tracking-tight">
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.short}</span>
            </span>
            {selected && (
              <motion.span
                layoutId={`${id}-indicator`}
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-ink"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export const viewPanelId = (key: string) => `view-panel-${key}`;
export const viewTabId = (key: string) => `view-tab-${key}`;

/**
 * A tab panel that stays mounted while hidden, so inner state (matrix period offset, fetched
 * checklist) survives switching views; it fades in each time it becomes active.
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
