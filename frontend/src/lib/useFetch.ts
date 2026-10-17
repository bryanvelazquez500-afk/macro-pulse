import { useEffect, useState } from "react";

type State<T> = { status: "loading" } | { status: "success"; data: T } | { status: "error"; error: string };

/**
 * Runs `load` once on mount and aborts it on unmount. Callers remount (via `key`) to refetch
 * for a new ticker, so the first render is always "loading" and stale responses are discarded.
 */
export function useFetch<T>(load: (signal: AbortSignal) => Promise<T>): State<T> {
  const [state, setState] = useState<State<T>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => setState({ status: "success", data }),
      (e) => {
        if (!controller.signal.aborted) setState({ status: "error", error: e instanceof Error ? e.message : "Request failed" });
      },
    );
    return () => controller.abort();
    // `load` is intentionally captured once per mount; see the doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
