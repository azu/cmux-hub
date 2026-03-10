import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";

export function usePlanData() {
  const { data, loading, error, isPending } = useWSFetch({
    fetch: () => api.getPlan(),
    wsMessageType: "plan-updated",
  });

  return {
    files: data?.found ? (data.files ?? []) : [],
    planPath: data?.path ?? null,
    loading,
    error: !loading && data && !data.found ? "Plan file not found" : error,
    isPending,
  };
}
