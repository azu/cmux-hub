import { useState, useEffect, useCallback, useTransition, useRef } from "react";

/**
 * Generic hook for fetching data with WebSocket-triggered refetch.
 *
 * - Initial fetch shows `loading: true`
 * - Subsequent fetches (triggered by WS events) use `useTransition` so the
 *   previous UI stays visible and `isPending` indicates background update.
 * - The `fetch` function can be an inline arrow — it is stored in a ref
 *   so that identity changes do not trigger re-fetches.
 *
 * Usage:
 *   const { data, loading, error, isPending, refetch } = useWSFetch({
 *     fetch: () => api.getPlan(),
 *     wsMessageType: "plan-updated",
 *   });
 *
 *   // Multiple WS message types:
 *   const { data } = useWSFetch({
 *     fetch: () => api.getStatus(),
 *     wsMessageType: ["diff-updated", "plan-updated"],
 *   });
 */
type UseWSFetchOptions<T> = {
  fetch: () => Promise<T>;
  wsMessageType?: string | string[];
};

type UseWSFetchResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  isPending: boolean;
  refetch: () => void;
};

export function useWSFetch<T>({
  fetch: fetchFn,
  wsMessageType,
}: UseWSFetchOptions<T>): UseWSFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  const refetch = useCallback(() => {
    fetchRef
      .current()
      .then((result) => {
        startTransition(() => {
          setData(result);
          setError(null);
          setLoading(false);
        });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Fetch failed");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const types = wsMessageType
    ? Array.isArray(wsMessageType)
      ? wsMessageType
      : [wsMessageType]
    : [];

  useEffect(() => {
    if (types.length === 0) return;
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as { type: string };
      if (types.includes(msg.type)) {
        refetch();
      }
    };
    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(","), refetch]);

  return { data, loading, error, isPending, refetch };
}
