import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";
import type { MenuItem } from "../../server/actions.ts";

export function useStatus() {
  const { data } = useWSFetch({
    fetch: () => api.getStatus(),
    wsMessageType: ["diff-updated", "plan-updated"],
  });

  return {
    loading: data === null,
    branch: data?.branch ?? "",
    hasTerminal: data?.terminalSurface != null,
    actions: (data?.actions as MenuItem[] | undefined) ?? [],
    hasPlan: data?.hasPlan ?? false,
    hasLauncher: (data as Record<string, unknown> | null)?.hasLauncher === true,
  };
}
