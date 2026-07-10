import type { ServerWebSocket } from "bun";
import path from "node:path";
import type { GitService } from "./git.ts";
import type { CmuxService } from "./cmux.ts";
import type { GitHubService } from "./github.ts";
import {
  validateRequest,
  securityHeaders,
  corsHeaders,
  isValidWebSocketOrigin,
} from "./middleware/security.ts";
import { parseDiff, type ParsedDiff } from "../src/lib/diff-parser.ts";
import { highlightDiffFiles } from "./diff-highlight.ts";
import { addWordDiffRanges } from "./word-diff.ts";
import { getLangFromPath, highlightLines } from "./highlighter.ts";
import { logger } from "./logger.ts";
import type { MenuItem } from "./actions.ts";
import { buildCommandWithEnv, findAction } from "./actions.ts";
import type { ProjectRegistry } from "./projects.ts";
import { findPlanFile } from "./plan.ts";
import { createPlanWatcher } from "./plan-watcher.ts";
import { isPathInsideReviewDirs, listReviewFiles } from "./review.ts";
import { createReviewWatcher } from "./review-watcher.ts";
import type { Launcher, ServerState } from "./launcher.ts";
import { generateInspectorScript } from "./inspector.ts";

type AppDeps = {
  port: number;
  /** Single-project mode default services. Optional in hub mode. */
  git?: GitService;
  cmux: CmuxService;
  github?: GitHubService;
  cwd?: string;
  /** Multi-project registry. When set, APIs accept a ?project=<id> param. */
  registry?: ProjectRegistry;
  defaultSurfaceId?: string;
  browserSurfaceId?: string;
  /** When true, serve dev-built frontend assets from devDistDir */
  development?: boolean;
  /** Directory containing dev-built frontend assets (used when development=true) */
  devDistDir?: string;
  /** Shutdown the process when all WebSocket clients disconnect */
  autoShutdownMs?: number;
  /** Menu actions for the toolbar */
  actions?: MenuItem[];
  /**
   * Directories that are watched and served by the Review view. Any markdown
   * file placed under these directories is shown as an AI-generated plan /
   * review document that the user can read before the work is committed.
   */
  reviewDirs?: string[];
  /** Launcher for managing dev servers from launch.json */
  launcher?: Launcher;
  /** Callback to open a cmux browser split for preview */
  openPreviewSplit?: (url: string) => Promise<string | null>;
  /** Callback to eval JS in a cmux browser surface */
  browserEval?: (surfaceRef: string, script: string) => Promise<string | null>;
  watcher?: {
    start(): void;
    onChanged(cb: (event: { hasRefChange: boolean }) => void): void;
    stop(): void;
  };
};

/**
 * Build route handlers, WebSocket config, and fetch handler.
 * The caller is responsible for calling `serve()` with the returned config
 * so that Bun's HTML bundler resolves asset paths correctly.
 */
export function createAppConfig(deps: AppDeps) {
  const { port, git, cmux, github, cwd, defaultSurfaceId, browserSurfaceId } = deps;
  // Hub mode serves multiple repos — restrict to the hub's own origin instead
  // of the single-mode any-localhost-port allowance (used by preview pages)
  const securityConfig = { port, strictOrigin: !!deps.registry };

  /**
   * Registration endpoints are for session hooks (curl), not browser pages.
   * Browsers always attach Origin and/or Sec-Fetch-Site to cross-origin
   * POSTs; rejecting requests that carry them stops a malicious localhost
   * page from registering arbitrary repos to read their files/diffs.
   */
  function rejectBrowserRegistration(req: Request): Response | null {
    if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) {
      return errorResponse("Registration is only allowed from non-browser clients", 403, req);
    }
    return null;
  }

  function resolveSurfaceId(surfaceId?: string): string | undefined {
    return surfaceId ?? defaultSurfaceId;
  }

  // Inspector re-injection interval (handles HMR/navigation in preview pages)
  let inspectorTimer: ReturnType<typeof setInterval> | null = null;

  function startInspectorReinjection() {
    if (inspectorTimer) return;
    inspectorTimer = setInterval(async () => {
      if (!deps.launcher || !deps.browserEval) return;
      const script = generateInspectorScript(securityConfig.port);
      for (const server of deps.launcher.getStates()) {
        if (server.status === "running" && server.surfaceRef) {
          await deps.browserEval(server.surfaceRef, script).catch(() => {});
        }
      }
    }, 3000);
  }

  function stopInspectorReinjection() {
    if (inspectorTimer) {
      clearInterval(inspectorTimer);
      inspectorTimer = null;
    }
  }

  // Map<ws, lastPongTimestamp>
  const wsClients = new Map<ServerWebSocket<unknown>, number>();
  // Track which clients are in foreground (visible tab)
  const wsVisible = new Map<ServerWebSocket<unknown>, boolean>();
  let planWatcherInstance: ReturnType<typeof createPlanWatcher> | null = null;
  let reviewWatcherInstance: ReturnType<typeof createReviewWatcher> | null = null;
  const reviewDirs = deps.reviewDirs ?? [];
  let hasHadClients = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const HEARTBEAT_INTERVAL = 30_000;
  const HEARTBEAT_TIMEOUT = 45_000;

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [ws, lastPong] of wsClients) {
        if (now - lastPong > HEARTBEAT_TIMEOUT) {
          logger.debug("stale ws detected, closing (no pong for", now - lastPong, "ms)");
          ws.close();
        } else {
          ws.ping();
        }
      }
      logger.debug("heartbeat ping sent to", wsClients.size, "clients");
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Cached GitHub data per project — updated by polling, served by API endpoints.
  // Single-project mode uses DEFAULT_PR_KEY; hub mode keys by project id.
  const DEFAULT_PR_KEY = "__default__";
  type PRStoreEntry = {
    pr: Awaited<ReturnType<NonNullable<AppDeps["github"]>["getCurrentPR"]>>;
    checks: Awaited<ReturnType<NonNullable<AppDeps["github"]>["getCIChecks"]>>;
    comments: Awaited<ReturnType<NonNullable<AppDeps["github"]>["getPRComments"]>>;
    fetchedAt: number;
  };
  const prStore = new Map<string, PRStoreEntry>();

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function pollProject(key: string, gitSvc: GitService, githubSvc: GitHubService) {
    let pr: PRStoreEntry["pr"];
    try {
      const branch = await gitSvc.getCurrentBranch();
      pr = await githubSvc.getCurrentPR(branch);
    } catch {
      // API error (network, auth, etc.) — keep cached values, skip update
      return;
    }
    let checks: PRStoreEntry["checks"] = [];
    let comments: PRStoreEntry["comments"] = [];
    if (pr) {
      try {
        [checks, comments] = await Promise.all([
          githubSvc.getCIChecks({ prNumber: pr.number }),
          githubSvc.getPRComments(pr.number),
        ]);
      } catch {
        // CI/comments fetch error — keep PR info but reuse previous checks/comments
        const prev = prStore.get(key);
        checks = prev?.checks ?? [];
        comments = prev?.comments ?? [];
      }
    }
    // The project may have been dismissed/pruned while this fetch was in
    // flight — don't resurrect its cache entry
    if (key !== DEFAULT_PR_KEY && deps.registry && !deps.registry.get(key)) return;
    prStore.set(key, { pr, checks, comments, fetchedAt: Date.now() });
    const message = JSON.stringify({
      type: "pr-updated",
      project: key === DEFAULT_PR_KEY ? undefined : key,
      data: { pr, checks, comments },
    });
    for (const ws of wsClients.keys()) {
      ws.send(message);
    }
  }

  async function pollGitHub() {
    if (deps.registry) {
      // GC cache entries for projects that were dismissed or pruned
      for (const key of prStore.keys()) {
        if (key !== DEFAULT_PR_KEY && !deps.registry.get(key)) prStore.delete(key);
      }
      await Promise.all(deps.registry.active().map((e) => pollProject(e.info.id, e.git, e.github)));
      return;
    }
    if (git && github) {
      await pollProject(DEFAULT_PR_KEY, git, github);
    }
  }

  /** Cache freshness window for on-demand PR reads (inactive projects aren't polled) */
  const PR_STALE_MS = 60_000;
  // In-flight on-demand fetches, deduped per project
  const prInflight = new Map<string, Promise<void>>();

  /** Read PR data for a project, fetching when the cache is missing or stale */
  async function getPRData(ctx: ProjectCtx): Promise<PRStoreEntry> {
    const key = ctx.id ?? DEFAULT_PR_KEY;
    const cached = prStore.get(key);
    if (cached && Date.now() - cached.fetchedAt < PR_STALE_MS) return cached;
    let inflight = prInflight.get(key);
    if (!inflight) {
      inflight = pollProject(key, ctx.git, ctx.github).finally(() => prInflight.delete(key));
      prInflight.set(key, inflight);
    }
    await inflight;
    return prStore.get(key) ?? cached ?? { pr: null, checks: [], comments: [], fetchedAt: 0 };
  }

  function startPolling() {
    if (pollTimer) return;
    // Fetch immediately, then poll every 60s
    pollGitHub();
    pollTimer = setInterval(pollGitHub, 60_000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** Returns true if any connected client has a visible (foreground) tab */
  function hasVisibleClient(): boolean {
    for (const visible of wsVisible.values()) {
      if (visible) return true;
    }
    return false;
  }

  /** Start or stop polling based on whether any client is in foreground */
  function updatePollingState() {
    if (wsClients.size === 0) {
      stopPolling();
      return;
    }
    if (hasVisibleClient()) {
      startPolling();
    } else {
      stopPolling();
    }
  }

  function addSecurityHeaders(response: Response, requestOrigin?: string | null): Response {
    const headers = { ...securityHeaders(), ...corsHeaders(securityConfig, requestOrigin) };
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  function jsonResponse(data: unknown, status = 200, req?: Request): Response {
    return addSecurityHeaders(Response.json(data, { status }), req?.headers.get("origin"));
  }

  function errorResponse(message: string, status = 500, req?: Request): Response {
    return jsonResponse({ error: message }, status, req);
  }

  /**
   * Request-scoped project context. Hub mode resolves ?project=<id> against
   * the registry; single-project mode falls back to the static deps.
   */
  type ProjectCtx = {
    id: string | null;
    cwd: string;
    git: GitService;
    github: GitHubService;
    actions: MenuItem[];
    surfaceId?: string;
  };

  function resolveProject(req: Request): ProjectCtx | Response {
    const url = new URL(req.url);
    const pid = url.searchParams.get("project");
    if (pid && deps.registry) {
      const entry = deps.registry.get(pid);
      if (!entry) return errorResponse("Unknown project: " + pid, 404, req);
      return {
        id: entry.info.id,
        cwd: entry.info.cwd,
        git: entry.git,
        github: entry.github,
        actions: entry.actions,
        surfaceId: entry.info.surfaceId,
      };
    }
    if (git && github && cwd) {
      return {
        id: null,
        cwd,
        git,
        github,
        actions: deps.actions ?? [],
        surfaceId: defaultSurfaceId,
      };
    }
    return errorResponse("project parameter required", 400, req);
  }

  type Delivery = { delivered: "cmux" } | { delivered: "clipboard"; text: string };

  /**
   * Deliver text to the project's agent session. Hub-registered projects
   * without a cmux surface (or with a dead socket) fall back to a clipboard
   * response — the frontend copies `text` and tells the user to paste it.
   * Single-project mode keeps the old behavior of targeting the focused
   * surface when none was registered.
   */
  async function deliverText(
    ctx: ProjectCtx,
    text: string,
    mode: "paste" | "command",
    surfaceOverride?: string,
  ): Promise<Delivery> {
    const surface = surfaceOverride ?? ctx.surfaceId;
    if (!surface && ctx.id !== null) {
      return { delivered: "clipboard", text };
    }
    try {
      if (mode === "command") {
        await cmux.sendCommand(text, surface);
      } else {
        await cmux.sendText(text, surface);
      }
      return { delivered: "cmux" };
    } catch (e) {
      logger.debug("cmux delivery failed, falling back to clipboard:", e);
      return { delivered: "clipboard", text };
    }
  }

  async function processAndHighlightDiff(raw: string, gitSvc: GitService): Promise<ParsedDiff> {
    const parsed = addWordDiffRanges(parseDiff(raw));
    const paths = parsed.map((f) => f.newPath);
    const generated = await gitSvc.getGeneratedFiles(paths);
    const toHighlight = parsed.filter((f) => !generated.has(f.newPath));
    const highlighted = await highlightDiffFiles(toHighlight);
    const generatedFiles = parsed
      .filter((f) => generated.has(f.newPath))
      .map((f) => ({ ...f, generated: true, hunks: [] }));
    return [...highlighted, ...generatedFiles];
  }

  const apiRoutes: Record<string, unknown> = {
    "/api/diff": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const url = new URL(req.url);
          const base = url.searchParams.get("base") ?? undefined;
          const target = url.searchParams.get("target") ?? undefined;
          const raw = await ctx.git.getDiff(base, target);
          const files = await processAndHighlightDiff(raw, ctx.git);
          return jsonResponse({ diff: raw, files });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/diff/auto": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const range = await ctx.git.computeDiffRange();
          const tracked = await ctx.git.getDiff(range.base);
          const untracked = range.includeUntracked ? await ctx.git.getUntrackedDiff() : "";
          const raw = [tracked, untracked].filter(Boolean).join("\n");
          const files = await processAndHighlightDiff(raw, ctx.git);
          return jsonResponse({
            diff: raw,
            files,
            base: range.base,
            includeUntracked: range.includeUntracked,
          });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/diff/files": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const url = new URL(req.url);
          const base = url.searchParams.get("base") ?? undefined;
          const target = url.searchParams.get("target") ?? undefined;
          const files = await ctx.git.getDiffFiles(base, target);
          return jsonResponse({ files });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/file-lines": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const url = new URL(req.url);
          const path = url.searchParams.get("path");
          const start = parseInt(url.searchParams.get("start") ?? "1", 10);
          const end = parseInt(url.searchParams.get("end") ?? "1", 10);
          if (!path) return errorResponse("path required", 400);
          const lines = await ctx.git.getFileLines(path, start, end);
          const lang = getLangFromPath(path);
          const tokenLines = await highlightLines(lines.join("\n"), lang);
          return jsonResponse({ lines, tokenLines });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/log": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const url = new URL(req.url);
          const count = parseInt(url.searchParams.get("count") ?? "20", 10);
          const commits = await ctx.git.getLogEntries(count);
          return jsonResponse({ commits });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/diff/commit": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const url = new URL(req.url);
          const hash = url.searchParams.get("hash");
          if (!hash) return errorResponse("hash required", 400);
          // Reject non-hex strings to prevent command injection via git show
          if (!/^[0-9a-f]{4,40}$/i.test(hash)) return errorResponse("invalid hash", 400);
          const raw = await ctx.git.getCommitDiff(hash);
          const files = await processAndHighlightDiff(raw, ctx.git);
          return jsonResponse({ diff: raw, files });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/branches": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const [branches, current] = await Promise.all([
            ctx.git.getBranches(),
            ctx.git.getCurrentBranch(),
          ]);
          return jsonResponse({ branches, current });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/projects": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.registry) return jsonResponse({ hubMode: false, projects: [] });
        try {
          const projects = await deps.registry.summaries((id) => {
            const data = prStore.get(id);
            if (!data?.pr) return null;
            const { number, title, state, url } = data.pr;
            return { number, title, state, url };
          });
          return jsonResponse({ hubMode: true, projects });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/projects/register": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const browserErr = rejectBrowserRegistration(req);
        if (browserErr) return browserErr;
        if (!deps.registry) return errorResponse("Hub mode not enabled", 404);
        try {
          const body = (await req.json()) as {
            cwd?: string;
            name?: string;
            harness?: string;
            surfaceId?: string;
          };
          if (!body.cwd || typeof body.cwd !== "string") {
            return errorResponse("cwd required", 400);
          }
          const entry = await deps.registry.register({
            cwd: body.cwd,
            name: body.name,
            harness: body.harness,
            surfaceId: body.surfaceId,
          });
          // Warm the PR cache in the background so the list shows PR state soon
          pollProject(entry.info.id, entry.git, entry.github).catch(() => {});
          return jsonResponse({ ok: true, id: entry.info.id, name: entry.info.name });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
        }
      },
    },

    "/api/projects/unregister": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const browserErr = rejectBrowserRegistration(req);
        if (browserErr) return browserErr;
        if (!deps.registry) return errorResponse("Hub mode not enabled", 404);
        try {
          const body = (await req.json()) as { id?: string; cwd?: string };
          const target = body.id ?? body.cwd;
          if (!target) return errorResponse("id or cwd required", 400);
          const ok = deps.registry.unregister(target);
          return jsonResponse({ ok });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/projects/heartbeat": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const browserErr = rejectBrowserRegistration(req);
        if (browserErr) return browserErr;
        if (!deps.registry) return errorResponse("Hub mode not enabled", 404);
        try {
          const body = (await req.json()) as { id?: string; cwd?: string };
          const target = body.id ?? body.cwd;
          if (!target) return errorResponse("id or cwd required", 400);
          const ok = deps.registry.heartbeat(target);
          return jsonResponse({ ok });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/projects/dismiss": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.registry) return errorResponse("Hub mode not enabled", 404);
        try {
          const body = (await req.json()) as { id?: string };
          if (!body.id) return errorResponse("id required", 400);
          // Resolve first so the PR cache is deleted by canonical id even
          // when the caller passed a cwd path
          const entry = deps.registry.resolve(body.id);
          const ok = deps.registry.dismiss(body.id);
          if (entry) prStore.delete(entry.info.id);
          return jsonResponse({ ok });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/status": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const hubMode = !!deps.registry;
        // Hub-level status (no project selected): just enough for the list page
        const url = new URL(req.url);
        if (hubMode && !url.searchParams.get("project")) {
          const reviewFiles = await listReviewFiles(reviewDirs).catch(() => []);
          return jsonResponse({
            hubMode,
            status: "",
            branch: "",
            cwd: "",
            terminalSurface: null,
            actions: [],
            hasPlan: false,
            hasReview: reviewFiles.length > 0,
            reviewDirs,
            hasLauncher: false,
          });
        }
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const [status, branch, planPath, reviewFiles] = await Promise.all([
            ctx.git.getStatus(),
            ctx.git.getCurrentBranch(),
            findPlanFile(ctx.cwd).catch(() => null),
            listReviewFiles(reviewDirs).catch(() => []),
          ]);
          const entry = ctx.id ? deps.registry?.get(ctx.id) : undefined;
          return jsonResponse({
            hubMode,
            status,
            branch,
            cwd: ctx.cwd,
            project: entry
              ? { id: entry.info.id, name: entry.info.name, status: entry.info.status }
              : null,
            terminalSurface: ctx.surfaceId ?? null,
            actions: ctx.actions,
            hasPlan: planPath !== null,
            hasReview: reviewFiles.length > 0,
            reviewDirs,
            hasLauncher: !!deps.launcher && !hubMode,
          });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/plan": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const planPath = await findPlanFile(ctx.cwd);
          if (!planPath) {
            return jsonResponse({ found: false });
          }
          const content = await Bun.file(planPath).text();
          const lines = content.split("\n");
          const tokenLines = await highlightLines(content, "markdown");
          const diffLines = lines.map((line, i) => ({
            type: "add" as const,
            content: line,
            oldLineNumber: null,
            newLineNumber: i + 1,
            tokens: tokenLines[i],
          }));
          return jsonResponse({
            found: true,
            path: planPath,
            files: [
              {
                oldPath: planPath,
                newPath: planPath,
                hunks: [
                  {
                    header: "",
                    oldStart: 0,
                    oldCount: 0,
                    newStart: 1,
                    newCount: lines.length,
                    lines: diffLines,
                  },
                ],
                isNew: true,
                isDeleted: false,
                isRenamed: false,
              },
            ],
          });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/review/delete": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = (await req.json()) as { path?: string };
          const target = body.path;
          if (!target) return errorResponse("path required", 400);
          if (!isPathInsideReviewDirs(target, reviewDirs)) {
            return errorResponse("path not in review dirs", 403);
          }
          // Bun.file().unlink() is not available; use node:fs
          const { rmSync } = await import("node:fs");
          try {
            rmSync(target, { force: true });
          } catch (e) {
            return errorResponse(e instanceof Error ? e.message : "failed to delete", 500);
          }
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/review": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const entries = await listReviewFiles(reviewDirs);
          if (entries.length === 0) {
            return jsonResponse({ found: false, reviewDirs });
          }
          const files = (
            await Promise.all(
              entries.map(async (entry) => {
                try {
                  const content = await Bun.file(entry.path).text();
                  const lines = content.split("\n");
                  const tokenLines = await highlightLines(content, "markdown");
                  const diffLines = lines.map((line, i) => ({
                    type: "add" as const,
                    content: line,
                    oldLineNumber: null,
                    newLineNumber: i + 1,
                    tokens: tokenLines[i],
                  }));
                  return {
                    oldPath: entry.path,
                    newPath: entry.path,
                    relativePath: entry.relativePath,
                    mtime: entry.mtime,
                    hunks: [
                      {
                        header: "",
                        oldStart: 0,
                        oldCount: 0,
                        newStart: 1,
                        newCount: lines.length,
                        lines: diffLines,
                      },
                    ],
                    isNew: true,
                    isDeleted: false,
                    isRenamed: false,
                  };
                } catch {
                  // File disappeared between scan and read, or became
                  // unreadable for some other reason — skip it instead of
                  // failing the whole endpoint.
                  return null;
                }
              }),
            )
          ).filter((f): f is NonNullable<typeof f> => f !== null);
          return jsonResponse({ found: true, reviewDirs, files });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/send-to-terminal": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const body = (await req.json()) as { text: string; surfaceId?: string };
          const delivery = await deliverText(ctx, body.text, "paste", body.surfaceId);
          return jsonResponse({ ok: true, ...delivery });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/comment": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const body = (await req.json()) as {
            file: string;
            startLine: number;
            endLine: number;
            comment: string;
            surfaceId?: string;
          };
          const range =
            body.startLine === body.endLine
              ? `${body.startLine}`
              : `${body.startLine}-${body.endLine}`;
          const text =
            body.startLine === 0 && body.endLine === 0
              ? `${body.file} ${body.comment}`
              : `${body.file}:${range} ${body.comment}`;
          const delivery = await deliverText(ctx, text, "paste", body.surfaceId);
          if (delivery.delivered === "cmux") {
            // send_text with \n may not submit in some inputs — press Enter explicitly
            await cmux.sendKey("Enter", body.surfaceId ?? ctx.surfaceId).catch(() => {});
          }
          return jsonResponse({ ok: true, ...delivery });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/command": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const body = (await req.json()) as { command: string; surfaceId?: string };
          const delivery = await deliverText(ctx, body.command, "command", body.surfaceId);
          return jsonResponse({ ok: true, ...delivery });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/action": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        try {
          const body = (await req.json()) as {
            id: string;
            variables?: Record<string, string>;
            surfaceId?: string;
          };
          const action = findAction(ctx.actions, body.id);
          if (!action) {
            return errorResponse("Action not found: " + body.id, 404);
          }
          const actionType = action.type;

          if (actionType === "shell") {
            // Build env variables: built-in + user-provided (only for shell type)
            const branch = await ctx.git.getCurrentBranch().catch(() => "");
            const diffRange = await ctx.git.computeDiffRange().catch(() => null);
            const base = diffRange?.base ?? "";
            const builtinVars: Record<string, string> = {
              CMUX_HUB_CWD: ctx.cwd,
              CMUX_HUB_GIT_BRANCH: branch,
              CMUX_HUB_GIT_BASE: base,
              CMUX_HUB_PORT: String(securityConfig.port),
              CMUX_HUB_SURFACE_ID: ctx.surfaceId ?? "",
              CMUX_HUB_BROWSER_SURFACE_ID: browserSurfaceId ?? "",
            };
            const allVars = { ...builtinVars, ...body.variables };
            const fullCommand = buildCommandWithEnv(action.command, allVars);
            logger.debug("shell action:", action.label, "command:", fullCommand);
            // Execute directly as subshell on server
            const shell = process.env.SHELL || "sh";
            const proc = Bun.spawn([shell, "-c", fullCommand], {
              cwd: ctx.cwd,
              stdout: "pipe",
              stderr: "pipe",
            });
            // Read stdout/stderr concurrently, but with a timeout.
            // Commands like `gh browse` / `open` spawn child processes that
            // inherit pipe FDs, so the pipes never close even after `sh` exits.
            const SHELL_TIMEOUT_MS = 30_000;
            const PIPE_GRACE_MS = 500;
            const timedText = (stream: ReadableStream<Uint8Array>, ms: number) =>
              Promise.race([
                new Response(stream).text(),
                new Promise<string>((resolve) => setTimeout(() => resolve(""), ms)),
              ]);
            const exitCode = await Promise.race([
              proc.exited,
              new Promise<-1>((resolve) => setTimeout(() => resolve(-1), SHELL_TIMEOUT_MS)),
            ]);
            if (exitCode === -1) {
              proc.kill();
            }
            // Once the process exits, give pipes a short grace period to flush
            const [stdout, stderr] = await Promise.all([
              timedText(proc.stdout, PIPE_GRACE_MS),
              timedText(proc.stderr, PIPE_GRACE_MS),
            ]);
            logger.debug("shell action result:", { exitCode, stdout, stderr });
            return jsonResponse({
              ok: exitCode === 0,
              command: fullCommand,
              stdout,
              stderr,
              exitCode,
            });
          }
          // For paste/paste-and-enter: only user-provided variables
          const termCommand = body.variables
            ? buildCommandWithEnv(action.command, body.variables)
            : action.command;
          const delivery = await deliverText(
            ctx,
            termCommand,
            actionType === "paste" ? "paste" : "command",
            body.surfaceId,
          );
          return jsonResponse({ ok: true, command: termCommand, ...delivery });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/launcher/status": {
      GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const states = deps.launcher?.getStates() ?? [];
        return jsonResponse({ servers: states, hasLauncher: !!deps.launcher });
      },
    },

    "/api/launcher/start": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.launcher) return errorResponse("No launcher configured", 404);
        try {
          const body = (await req.json()) as { name?: string };
          await deps.launcher.start(body.name);
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/launcher/stop": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.launcher) return errorResponse("No launcher configured", 404);
        try {
          const body = (await req.json()) as { name?: string };
          await deps.launcher.stop(body.name);
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/launcher/restart": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.launcher) return errorResponse("No launcher configured", 404);
        try {
          const body = (await req.json()) as { name?: string };
          await deps.launcher.restart(body.name);
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/launcher/preview": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.launcher) return errorResponse("No launcher configured", 404);
        if (!deps.openPreviewSplit) return errorResponse("Preview not available", 501);
        try {
          const body = (await req.json()) as { name: string };
          const states = deps.launcher.getStates();
          const server = states.find((s) => s.name === body.name);
          if (!server) return errorResponse(`Server "${body.name}" not found`, 404);
          if (server.status !== "running")
            return errorResponse(`Server "${body.name}" is not running`, 400);

          const previewUrl = `http://127.0.0.1:${server.port}`;

          // Reuse existing surface if it's still alive
          let surfaceRef = server.surfaceRef ?? null;
          if (surfaceRef && deps.browserEval) {
            const result = await deps
              .browserEval(surfaceRef, `window.location.href = ${JSON.stringify(previewUrl)}; "ok"`)
              .catch(() => null);
            if (!result) {
              // Surface is dead, open a new one
              surfaceRef = null;
            }
          }

          if (!surfaceRef) {
            surfaceRef = await deps.openPreviewSplit(previewUrl);
          }

          if (surfaceRef) {
            deps.launcher.setSurfaceRef(body.name, surfaceRef);
            // Auto-inject inspector and start periodic re-injection for HMR/navigation
            if (deps.browserEval) {
              const script = generateInspectorScript(securityConfig.port);
              await deps.browserEval(surfaceRef, script).catch(() => {});
              startInspectorReinjection();
            }
          }
          return jsonResponse({ ok: true, surfaceRef });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/launcher/inject": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        if (!deps.launcher) return errorResponse("No launcher configured", 404);
        if (!deps.browserEval) return errorResponse("Browser eval not available", 501);
        try {
          const body = (await req.json()) as { name: string };
          const states = deps.launcher.getStates();
          const server = states.find((s) => s.name === body.name);
          if (!server) return errorResponse(`Server "${body.name}" not found`, 404);
          if (!server.surfaceRef)
            return errorResponse(`No preview surface for "${body.name}"`, 400);

          const script = generateInspectorScript(securityConfig.port);
          await deps.browserEval(server.surfaceRef, script);
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/preview-comment": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) {
          // Add CORS headers to error response so browser can read the error
          addSecurityHeaders(secErr, req.headers.get("origin"));
          return secErr;
        }
        try {
          const body = (await req.json()) as {
            element: {
              selector: string;
              tagName: string;
              textContent: string;
              className: string;
              attributes: Record<string, string>;
              boundingBox: { x: number; y: number; width: number; height: number };
            };
            comment: string;
            url: string;
            includeScreenshot?: boolean;
          };

          // Format the comment for Claude Code
          // When coming from react-grab, element info is empty and comment contains full context
          let text: string;
          if (body.element.tagName) {
            const elementDesc = [
              `Element: <${body.element.tagName}>`,
              `Selector: ${body.element.selector}`,
              body.element.textContent
                ? `Text: "${body.element.textContent.substring(0, 100)}"`
                : null,
              `Page: ${body.url}`,
            ]
              .filter(Boolean)
              .join("\n");
            text = `[Preview Comment]\n${elementDesc}\n\nComment: ${body.comment}\n`;
          } else {
            text = `[Preview Comment]\nPage: ${body.url}\n\n${body.comment}\n`;
          }

          // Try to capture screenshot if requested
          if (body.includeScreenshot && deps.launcher && deps.browserEval) {
            // Find the server that matches this URL
            const states = deps.launcher.getStates();
            const matchingServer = states.find(
              (s) => s.surfaceRef && body.url.includes(`:${s.port}`),
            );
            if (matchingServer?.surfaceRef) {
              try {
                // Use cmux browser snapshot for DOM snapshot
                const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
                const proc = Bun.spawn(
                  [CMUX_BIN, "browser", matchingServer.surfaceRef, "snapshot", "--compact"],
                  { stdout: "pipe", stderr: "pipe" },
                );
                const snapshot = await new Response(proc.stdout).text();
                await proc.exited;
                if (snapshot.trim()) {
                  const snapshotText = `\n[DOM Snapshot]\n${snapshot.substring(0, 2000)}\n`;
                  await cmux.sendText(text + snapshotText, resolveSurfaceId());
                  return jsonResponse({ ok: true }, 200, req);
                }
              } catch {
                // Fall through to send without snapshot
              }
            }
          }

          await cmux.sendText(text, resolveSurfaceId());
          return jsonResponse({ ok: true }, 200, req);
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error", 500, req);
        }
      },
    },

    "/api/pr": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        const data = await getPRData(ctx);
        return jsonResponse({ pr: data.pr });
      },
    },

    "/api/pr/comments": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        const data = await getPRData(ctx);
        return jsonResponse({ comments: data.comments });
      },
    },

    "/api/ci": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        const ctx = resolveProject(req);
        if (ctx instanceof Response) return ctx;
        const data = await getPRData(ctx);
        return jsonResponse({ checks: data.checks });
      },
    },
  };

  // upgradeServer must be set by the caller after serve() returns
  let upgradeServer: { upgrade(req: Request, opts: { data: unknown }): boolean } | null = null;

  return {
    apiRoutes,

    setServer(server: {
      upgrade(req: Request, opts: { data: unknown }): boolean;
      port: number | undefined;
    }) {
      upgradeServer = server;
      securityConfig.port = server.port ?? 0;
    },

    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        wsClients.set(ws, Date.now());
        wsVisible.set(ws, true); // assume foreground on connect
        hasHadClients = true;
        logger.debug("ws open, clients:", wsClients.size);
        if (shutdownTimer) {
          logger.debug("shutdown timer cancelled (new client)");
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
        updatePollingState();
        startHeartbeat();
      },
      message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
        try {
          const msg = JSON.parse(typeof message === "string" ? message : message.toString());
          if (msg.type === "visibility" && typeof msg.visible === "boolean") {
            wsVisible.set(ws, msg.visible);
            logger.debug(
              "ws visibility:",
              msg.visible,
              "foreground clients:",
              [...wsVisible.values()].filter(Boolean).length,
            );
            updatePollingState();
          }
        } catch {
          // ignore parse errors
        }
      },
      pong(ws: ServerWebSocket<unknown>) {
        wsClients.set(ws, Date.now());
        logger.debug("ws pong received, clients:", wsClients.size);
      },
      close(ws: ServerWebSocket<unknown>) {
        wsClients.delete(ws);
        wsVisible.delete(ws);
        logger.debug("ws close, clients:", wsClients.size);
        if (wsClients.size === 0) {
          stopPolling();
          stopHeartbeat();
          // Auto-shutdown when all clients disconnect
          if (hasHadClients && deps.autoShutdownMs !== undefined) {
            logger.debug("shutdown timer started:", deps.autoShutdownMs, "ms");
            shutdownTimer = setTimeout(() => {
              logger.info("All clients disconnected, shutting down.");
              process.exit(0);
            }, deps.autoShutdownMs);
          }
        } else {
          // Remaining clients may all be background — update polling
          updatePollingState();
        }
      },
    },

    fetch(req: Request) {
      const url = new URL(req.url);
      const requestOrigin = req.headers.get("origin");

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(securityConfig, requestOrigin),
        });
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (!isValidWebSocketOrigin(req, securityConfig)) {
          return new Response("Forbidden: invalid origin", { status: 403 });
        }
        if (upgradeServer) {
          const upgraded = upgradeServer.upgrade(req, { data: {} });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
        }
        return undefined;
      }

      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }

      // Dev mode: serve built frontend files from devDistDir
      if (deps.development && deps.devDistDir) {
        const filePath = path.join(
          deps.devDistDir,
          url.pathname === "/" ? "index.html" : url.pathname.slice(1),
        );
        return new Response(Bun.file(filePath));
      }

      return new Response("Not Found", { status: 404 });
    },

    startWatcher() {
      if (deps.watcher) {
        deps.watcher.start();
        deps.watcher.onChanged((event) => {
          const message = JSON.stringify({ type: "diff-updated" });
          for (const ws of wsClients.keys()) {
            ws.send(message);
          }
          // On ref changes (push, fetch, branch switch), poll GitHub immediately
          if (event.hasRefChange) {
            pollGitHub();
          }
        });
      }

      const broadcast = (message: string) => {
        for (const ws of wsClients.keys()) {
          ws.send(message);
        }
      };
      if (cwd) {
        planWatcherInstance = createPlanWatcher(cwd, broadcast);
        planWatcherInstance.start();
      }

      if (reviewDirs.length > 0) {
        reviewWatcherInstance = createReviewWatcher(reviewDirs, broadcast);
        reviewWatcherInstance.start();
      }
    },

    broadcast(message: string) {
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
    },

    /** Hub mode: called by the registry when a project's files/refs change */
    broadcastDiffUpdated(projectId: string, event: { hasRefChange: boolean }) {
      const message = JSON.stringify({ type: "diff-updated", project: projectId });
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
      if (event.hasRefChange) {
        const entry = deps.registry?.get(projectId);
        if (entry) pollProject(projectId, entry.git, entry.github);
      }
    },

    /** Hub mode: called by the registry when the project list changes */
    broadcastProjectsUpdated() {
      const message = JSON.stringify({ type: "projects-updated" });
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
    },

    broadcastLauncherUpdate(states: ServerState[]) {
      const message = JSON.stringify({ type: "launcher-updated", data: { servers: states } });
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
    },

    /** Fetch GitHub data once (for tests or initial load) */
    pollGitHub,

    stop() {
      stopPolling();
      deps.watcher?.stop();
      planWatcherInstance?.stop();
      planWatcherInstance = null;
      reviewWatcherInstance?.stop();
      reviewWatcherInstance = null;
      stopInspectorReinjection();
    },
  };
}
