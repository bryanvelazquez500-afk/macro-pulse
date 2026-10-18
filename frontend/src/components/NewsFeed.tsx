"use client";

import { fetchNews } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";

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

/**
 * Headlines for one company. `expanded` false shows the latest two (the panel's collapsed state);
 * the header toggles between that and the full list.
 */
export function NewsFeed({ ticker, expanded = true, onToggle }: { ticker: string; expanded?: boolean; onToggle?: () => void }) {
  const state = useFetch((signal) => fetchNews(ticker, signal));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group mb-3 flex w-full items-center justify-between gap-2 text-left"
      >
        <h2 className="eyebrow">
          Related News
          {state.status === "success" && <span className="ml-1.5 text-ink-4 normal-case">· {state.data.ticker}</span>}
        </h2>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-3 group-hover:text-ink">
          {state.status === "success" && state.data.items.length > 2 && (expanded ? "Show less" : `All ${state.data.items.length}`)}
          <span aria-hidden className={`inline-block transition-transform ${expanded ? "-rotate-90" : "rotate-90"}`}>
            ›
          </span>
        </span>
      </button>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {state.status === "loading" && (
          <ul className="space-y-3" aria-busy="true" aria-label="Loading headlines">
            {Array.from({ length: expanded ? 6 : 2 }, (_, i) => (
              <li key={i} className="space-y-1.5">
                <div className="h-3.5 w-full animate-pulse rounded bg-subtle" />
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-subtle" />
              </li>
            ))}
          </ul>
        )}
        {state.status === "error" && <p className="text-[13px] text-red-600 dark:text-red-400">{state.error}</p>}
        {state.status === "success" &&
          (state.data.items.length === 0 ? (
            <p className="text-[13px] text-ink-3">No headlines for {state.data.ticker} in the last 7 days.</p>
          ) : (
            <ol className="divide-y divide-line">
              {(expanded ? state.data.items : state.data.items.slice(0, 2)).map((item) => (
                <li key={item.url} className="py-2.5 first:pt-0">
                  <a
                    href={safeHref(item.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] leading-snug text-ink decoration-line-strong underline-offset-2 hover:underline"
                  >
                    {item.title}
                  </a>
                  <div className="mt-0.5 text-[11px] text-ink-3">
                    {[item.source, timeAgo(item.published_at)].filter(Boolean).join(" · ")}
                  </div>
                </li>
              ))}
            </ol>
          ))}
      </div>
    </div>
  );
}
