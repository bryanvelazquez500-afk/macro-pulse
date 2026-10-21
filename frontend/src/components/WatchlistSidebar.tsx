"use client";

import { formatUsd } from "@/lib/format";
import { usePortfolio } from "@/lib/portfolioStore";

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-sm px-1.5 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:bg-subtle hover:text-ink focus:opacity-100"
    >
      ×
    </button>
  );
}

/**
 * Left rail: saved tickers. Companies are added from the header search or "+ Add" for the focused
 * company — there are no input forms here, to keep the rail clear. Holdings recorded earlier are
 * still listed (read-only) so saved data doesn't silently disappear.
 */
export function WatchlistSidebar({ activeTicker, onSelect }: { activeTicker: string | null; onSelect: (ticker: string) => void }) {
  const { portfolio, addToWatchlist, removeFromWatchlist, removeHolding } = usePortfolio();

  const canAddActive = activeTicker && !portfolio.watchlist.includes(activeTicker);
  const totalCost = portfolio.holdings.reduce((sum, h) => sum + (h.costBasis != null ? h.shares * h.costBasis : 0), 0);

  const itemClass = (ticker: string) =>
    `mp-interactive group relative flex items-center justify-between rounded-sm px-2 py-1.5 text-[13px] ${
      ticker === activeTicker ? "bg-subtle text-ink shadow-[inset_2px_0_0_var(--ink)]" : "text-ink-2"
    }`;

  return (
    <div className="space-y-8 px-1">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="eyebrow">Watchlist</h2>
          {canAddActive && (
            <button type="button" onClick={() => addToWatchlist(activeTicker)} className="link text-[12px]">
              + Add {activeTicker}
            </button>
          )}
        </div>
        {portfolio.watchlist.length === 0 ? (
          <p className="px-2 py-1 text-xs text-ink-3">No saved tickers yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {portfolio.watchlist.map((t) => (
              <li key={t} className={itemClass(t)}>
                <button type="button" onClick={() => onSelect(t)} className="flex-1 text-left font-mono font-medium">
                  {t}
                </button>
                <RemoveButton label={`Remove ${t} from watchlist`} onClick={() => removeFromWatchlist(t)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {portfolio.holdings.length > 0 && (
        <section>
          <h2 className="mb-2 eyebrow">Holdings</h2>
          <ul className="space-y-0.5">
            {portfolio.holdings.map((h) => (
              <li key={h.ticker} className={itemClass(h.ticker)}>
                <button type="button" onClick={() => onSelect(h.ticker)} className="flex-1 text-left">
                  <div className="font-mono font-medium">{h.ticker}</div>
                  <div className="text-[12px] text-ink-3">
                    {h.shares.toLocaleString()} sh{h.costBasis != null && ` @ $${h.costBasis.toLocaleString()} · ${formatUsd(h.shares * h.costBasis)}`}
                  </div>
                </button>
                <RemoveButton label={`Remove ${h.ticker} holding`} onClick={() => removeHolding(h.ticker)} />
              </li>
            ))}
          </ul>
          {totalCost > 0 && (
            <div className="mt-2 flex justify-between border-t border-line px-2 pt-2 text-[12px] text-ink-3">
              <span>Total cost basis</span>
              <span className="">{formatUsd(totalCost)}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
