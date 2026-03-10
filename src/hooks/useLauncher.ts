import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";

export type LauncherServer = {
  name: string;
  status: string;
  port: number;
  configPort: number;
  error?: string;
  surfaceRef?: string;
};

export function useLauncher() {
  const { data } = useWSFetch({
    fetch: () => api.getLauncherStatus(),
    wsMessageType: "launcher-updated",
  });

  return {
    loading: data === null,
    hasLauncher: data?.hasLauncher ?? false,
    servers: data?.servers ?? [],
  };
}
