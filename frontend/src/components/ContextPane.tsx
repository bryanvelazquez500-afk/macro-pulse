"use client";

import { useState } from "react";

import { NewsFeed } from "@/components/NewsFeed";

/** Related news for the focused company: collapsed to the latest two headlines, expandable to all. */
export function ContextPane({ ticker }: { ticker: string | null }) {
  const [expanded, setExpanded] = useState(false);
  return ticker ? (
    <section className={`panel flex min-h-0 flex-col p-4 ${expanded ? "max-h-[32rem]" : ""}`}>
      {/* Keyed by ticker so each company starts fresh and in-flight requests for the old one are aborted. */}
      <NewsFeed key={ticker} ticker={ticker} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
    </section>
  ) : (
    <div className="rounded-md border border-dashed border-line-strong p-4 text-[13px] text-ink-3">Search a company to see related news.</div>
  );
}
