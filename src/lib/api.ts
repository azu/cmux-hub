import type { ServerState } from "../../server/launcher.ts";

const BASE_URL = "";

// Hub mode: the project currently being viewed. Set from the hash route
// before render so every API call is scoped to the right project.
let currentProject: string | null = null;

export function setApiProject(project: string | null) {
  currentProject = project;
}

export function getApiProject(): string | null {
  return currentProject;
}

/** How a terminal-bound payload was actually delivered by the server */
export type DeliveryResult = {
  ok: boolean;
  delivered?: "cmux" | "clipboard";
  text?: string;
};

function withProject(path: string): string {
  if (!currentProject) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}project=${encodeURIComponent(currentProject)}`;
}

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${withProject(path)}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type ProjectSummary = {
  id: string;
  cwd: string;
  name: string;
  status: "active" | "inactive";
  harness?: string;
  registeredAt: number;
  lastSeenAt: number;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  pr: { number: number; title: string; state: string; url: string } | null;
};

export const api = {
  getProjects() {
    return fetchJSON<{ hubMode: boolean; projects: ProjectSummary[] }>("/api/projects");
  },

  dismissProject(id: string) {
    return fetchJSON<{ ok: boolean }>("/api/projects/dismiss", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  },
  getDiff(base?: string, target?: string) {
    const params = new URLSearchParams();
    if (base) params.set("base", base);
    if (target) params.set("target", target);
    const qs = params.toString();
    return fetchJSON<{ diff: string; files?: import("./diff-parser.ts").ParsedDiff }>(
      `/api/diff${qs ? `?${qs}` : ""}`,
    );
  },

  getAutoDiff() {
    return fetchJSON<{
      diff: string;
      files?: import("./diff-parser.ts").ParsedDiff;
      base: string;
      includeUntracked: boolean;
    }>("/api/diff/auto");
  },

  getDiffFiles(base?: string, target?: string) {
    const params = new URLSearchParams();
    if (base) params.set("base", base);
    if (target) params.set("target", target);
    const qs = params.toString();
    return fetchJSON<{ files: string[] }>(`/api/diff/files${qs ? `?${qs}` : ""}`);
  },

  getFileLines(path: string, start: number, end: number) {
    const params = new URLSearchParams({ path, start: String(start), end: String(end) });
    return fetchJSON<{ lines: string[]; tokenLines: import("./diff-parser.ts").DiffToken[][] }>(
      `/api/file-lines?${params}`,
    );
  },

  getLog(count = 20) {
    return fetchJSON<{ commits: Array<{ hash: string; message: string; relativeDate: string }> }>(
      `/api/log?count=${count}`,
    );
  },

  getCommitDiff(hash: string) {
    return fetchJSON<{ diff: string; files?: import("./diff-parser.ts").ParsedDiff }>(
      `/api/diff/commit?hash=${encodeURIComponent(hash)}`,
    );
  },

  getBranches() {
    return fetchJSON<{ branches: string[]; current: string }>("/api/branches");
  },

  getStatus() {
    return fetchJSON<{
      hubMode?: boolean;
      status: string;
      branch: string;
      cwd: string;
      project?: { id: string; name: string; status: "active" | "inactive" } | null;
      terminalSurface: string | null;
      actions: import("../../server/actions.ts").MenuItem[];
      hasPlan: boolean;
      hasReview: boolean;
      reviewDirs: string[];
    }>("/api/status");
  },

  getReview() {
    return fetchJSON<{
      found: boolean;
      reviewDirs: string[];
      files?: Array<
        import("./diff-parser.ts").ParsedDiff[number] & {
          relativePath: string;
          mtime: number;
        }
      >;
    }>("/api/review");
  },

  deleteReview(path: string) {
    return fetchJSON<{ ok: boolean }>("/api/review/delete", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },

  getPlan() {
    return fetchJSON<{
      found: boolean;
      path?: string;
      files?: import("./diff-parser.ts").ParsedDiff;
    }>("/api/plan");
  },

  sendToTerminal(text: string, surfaceId?: string) {
    return fetchJSON<DeliveryResult>("/api/send-to-terminal", {
      method: "POST",
      body: JSON.stringify({ text, surfaceId }),
    });
  },

  sendComment(
    file: string,
    startLine: number,
    endLine: number,
    comment: string,
    surfaceId?: string,
  ) {
    return fetchJSON<DeliveryResult>("/api/comment", {
      method: "POST",
      body: JSON.stringify({ file, startLine, endLine, comment, surfaceId }),
    });
  },

  sendCommand(command: string, surfaceId?: string) {
    return fetchJSON<DeliveryResult>("/api/command", {
      method: "POST",
      body: JSON.stringify({ command, surfaceId }),
    });
  },

  getPR() {
    return fetchJSON<{ pr: unknown }>("/api/pr");
  },

  getPRComments() {
    return fetchJSON<{ comments: unknown[] }>("/api/pr/comments");
  },

  getCI() {
    return fetchJSON<{ checks: unknown[] }>("/api/ci");
  },

  executeAction(id: string, variables?: Record<string, string>, surfaceId?: string) {
    return fetchJSON<DeliveryResult & { command: string }>("/api/action", {
      method: "POST",
      body: JSON.stringify({ id, variables, surfaceId }),
    });
  },

  getLauncherStatus() {
    return fetchJSON<{ servers: ServerState[]; hasLauncher: boolean }>("/api/launcher/status");
  },

  launcherStart(name?: string) {
    return fetchJSON<{ ok: boolean }>("/api/launcher/start", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  launcherStop(name?: string) {
    return fetchJSON<{ ok: boolean }>("/api/launcher/stop", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  launcherRestart(name?: string) {
    return fetchJSON<{ ok: boolean }>("/api/launcher/restart", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  launcherPreview(name: string) {
    return fetchJSON<{ ok: boolean; surfaceRef?: string }>("/api/launcher/preview", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
};
