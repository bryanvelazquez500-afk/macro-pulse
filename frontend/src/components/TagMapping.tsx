import type { FinancialPeriod, MetricKey } from "@/lib/api";
import { METRIC_LABELS } from "@/lib/metrics";

/** Shows which raw tags (US GAAP, IFRS or FMP fields) this company's numbers were mapped from. */
export function TagMapping({
  tagMap,
  periods,
  bare = false,
}: {
  tagMap: Record<MetricKey, string[]>;
  periods: FinancialPeriod[];
  /** Without its own panel border, for use inside a drawer. */
  bare?: boolean;
}) {
  return (
    <div className={`grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 ${bare ? "" : "panel p-5"}`}>
      {(Object.keys(METRIC_LABELS) as MetricKey[]).map((key) => {
        // "Tag (split-adjusted ×10)" still counts as that tag being in use.
        const used = new Set(periods.map((p) => p.line_items[key]?.source_tag.replace(/ \(split-adjusted .*\)$/, "")).filter(Boolean));
        const tags = tagMap[key] ?? [];
        const derived = [...used].filter((tag) => !tags.includes(tag as string));
        return (
          <div key={key}>
            <div className="mb-2 text-[13px] text-ink">{METRIC_LABELS[key]}</div>
            <ul className="space-y-1 font-mono text-[11px] break-all">
              {[...tags, ...derived].map((tag) => (
                <li key={tag} className={used.has(tag) ? "text-ink" : "text-ink-4"}>
                  <span aria-hidden className="mr-1.5">{used.has(tag) ? "■" : "□"}</span>
                  {tag}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
