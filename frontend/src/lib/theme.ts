"use client";

import { useSyncExternalStore } from "react";

import { THEME_KEY } from "@/lib/themeScript";

/**
 * Light ("Daylight ledger") / dark ("Night ledger") theme. The choice lives in data-theme on <html>:
 * THEME_SCRIPT (lib/themeScript.ts, inlined in <head> by layout.tsx) sets it before first paint from localStorage, or from the
 * system setting when nothing is saved, so there's no flash of the wrong theme.
 */

export type Theme = "light" | "dark";
function read(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The active theme; components that paint with JS (canvas, chart libraries) re-render when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light");
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // private mode / blocked storage: the choice just won't persist
  }
}

/** A token's current value (e.g. cssVar("--spruce")), for canvas and chart code that can't use var(). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
