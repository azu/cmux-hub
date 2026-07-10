import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";
import type { MenuItem } from "../../server/actions.ts";

export function useStatus() {
  const { data, error } = useWSFetch({
    fetch: () => api.getStatus(),
    wsMessageType: ["diff-updated", "plan-updated", "review-updated"],
  });

  return {
    loading: data === null,
    error,
    hubMode: data?.hubMode === true,
    branch: data?.branch ?? "",
    projectName: data?.project?.name ?? null,
    projectStatus: data?.project?.status ?? null,
    hasTerminal: data?.terminalSurface != null,
    actions: (data?.actions as MenuItem[] | undefined) ?? [],
    hasPlan: data?.hasPlan ?? false,
    hasReview: data?.hasReview ?? false,
    hasLauncher: (data as Record<string, unknown> | null)?.hasLauncher === true,
  };
}
