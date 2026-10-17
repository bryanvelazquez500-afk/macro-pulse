"use client";

import { ReactNode } from "react";

const STICKY = {
  // Literal class strings so Tailwind can see them.
  lg: "lg:sticky lg:top-[calc(var(--header-h,6rem)+2rem)] lg:max-h-[calc(100vh-var(--header-h,6rem)-3rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1",
  xl: "xl:sticky xl:top-[calc(var(--header-h,6rem)+2rem)] xl:max-h-[calc(100vh-var(--header-h,6rem)-3rem)] xl:overflow-y-auto xl:overscroll-contain xl:pr-1",
} as const;

/**
 * A rail of the dashboard grid. Sticky (from the given breakpoint) with its own scroll, so its tools
 * stay in view while the center column scrolls.
 */
export function SidePanel({ label, stickyFrom = "xl", children }: { label: string; stickyFrom?: keyof typeof STICKY; children: ReactNode }) {
  return (
    <aside
      aria-label={label}
      // Children keep their natural height (shrink-0); the rail scrolls instead of squashing them.
      className={`flex flex-col gap-6 *:shrink-0 ${STICKY[stickyFrom]}`}
    >
      {children}
    </aside>
  );
}
