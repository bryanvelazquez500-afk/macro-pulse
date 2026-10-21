"use client";

/**
 * Wall Street–style news tape: the focused company's latest headlines glide continuously to the
 * right across a bar under the header. Hovering or focusing a headline pauses the tape; every
 * headline opens the article in a new tab. With reduced motion the tape stays still and scrolls by hand.
 */

import { useMemo } from "react";

import { fetchNews } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";

const PX_PER_SECOND = 55; // reading speed of the tape

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Render only http(s) links, even though the backend already filters them. */
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);

function Tape({ ticker }: { ticker: string }) {
  const state = useFetch((signal) => fetchNews(ticker, signal));
  const items = useMemo(() => (state.status === "success" ? state.data.items : []), [state]);
  // Rough tape length → constant speed whatever the number of headlines.
  const duration = useMemo(() => Math.max(30, items.reduce((n, h) => n + h.title.length * 7 + 180, 0) / PX_PER_SECOND), [items]);

  if (state.status === "loading") return <span className="px-4 text-[13px] text-ink-3">Loading {ticker} headlines…</span>;
  if (state.status === "error") return <span className="px-4 text-[13px] text-ink-3">Headlines for {ticker} are unavailable right now.</span>;
  if (items.length === 0) return <span className="px-4 text-[13px] text-ink-3">No {ticker} headlines in the last 7 days.</span>;

  const run = (copy: number) =>
    items.map((h) => (
      <span key={`${copy}-${h.url}`} className="flex shrink-0 items-center">
        <a
          href={safeHref(h.url)}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={copy === 0 ? 0 : -1}
          aria-hidden={copy === 0 ? undefined : true}
          className="group/item flex items-center gap-2 rounded-xs px-1 py-0.5 whitespace-nowrap"
        >
          <span className="text-[13px] font-medium text-ink-2 transition-colors duration-[var(--dur-1)] group-hover/item:text-spruce group-hover/item:underline">{h.title}</span>
          <span className="text-[12px] text-ink-3">
            {[h.source, timeAgo(h.published_at)].filter(Boolean).join(" · ")}
          </span>
        </a>
        <span aria-hidden className="mx-5 size-1 rounded-full bg-line-strong" />
      </span>
    ));

  return (
    // Two identical runs: the track moves exactly one run's width, so the loop is seamless.
    <div className="mp-tape flex w-max" style={{ animationDuration: `${duration}s` }}>
      <div className="flex">{run(0)}</div>
      <div className="flex">{run(1)}</div>
    </div>
  );
}

export function NewsTicker({ ticker }: { ticker: string | null }) {
  return (
    <div
      id="tour-news"
      className="flex h-10 items-stretch overflow-hidden rounded-full border border-line bg-panel"
      role="region"
      aria-label={ticker ? `Latest ${ticker} headlines` : "Headlines"}
    >
      <div className="z-10 flex shrink-0 items-center gap-2 border-r border-line bg-panel pr-3 pl-4">
        <span aria-hidden className="mp-live-dot size-2 rounded-full bg-brass" />
        <span className="eyebrow !text-ink-2">News</span>
        {ticker && <span className="font-mono text-[12px] font-semibold text-ink">{ticker}</span>}
      </div>
      <div className="mp-tape-viewport relative flex min-w-0 flex-1 items-center overflow-hidden">
        {ticker ? <Tape key={ticker} ticker={ticker} /> : <span className="px-4 text-[13px] text-ink-3">Add a company to see its headlines.</span>}
      </div>
    </div>
  );
}
