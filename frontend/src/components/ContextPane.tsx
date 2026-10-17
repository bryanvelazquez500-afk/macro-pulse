"use client";

import { NewsFeed } from "@/components/NewsFeed";

/** Related news for the focused company. Lives inside the SidePanel rail. */
export function ContextPane({ ticker }: { ticker: string | null }) {
  return ticker ? (
    <section className="panel flex h-[34rem] min-h-0 flex-col p-4 xl:h-[calc(100vh-var(--header-h,6rem)-3rem)]">
      {/* Keyed by ticker so each company starts fresh and in-flight requests for the old one are aborted. */}
      <NewsFeed key={ticker} ticker={ticker} />
    </section>
  ) : (
    <div className="rounded-md border border-dashed border-line-strong p-4 text-[13px] text-ink-3">Search a company to see related news.</div>
  );
}
