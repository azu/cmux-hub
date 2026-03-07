import type { ServerWebSocket } from "bun";
import type { GitService } from "./git.ts";
import type { CmuxService } from "./cmux.ts";
import type { GitHubService } from "./github.ts";
import {
  validateRequest,
  securityHeaders,
  corsHeaders,
  isValidWebSocketOrigin,
} from "./middleware/security.ts";
import { parseDiff } from "../src/lib/diff-parser.ts";
import { highlightDiffFiles } from "./diff-highlight.ts";
import { getLangFromPath, highlightLines } from "./highlighter.ts";
import { logger } from "./logger.ts";
import type { MenuItem } from "./actions.ts";
import { buildCommandWithEnv, findAction } from "./actions.ts";
import { findPlanFile } from "./plan.ts";

type AppDeps = {
  port: number;
  git: GitService;
  cmux: CmuxService;
  github: GitHubService;
  cwd: string;
  defaultSurfaceId?: string;
  /** When true, return undefined from fetch for unmatched routes (needed for Bun dev server asset serving) */
  development?: boolean;
  /** Shutdown the process when all WebSocket clients disconnect */
  autoShutdownMs?: number;
  /** Menu actions for the toolbar */
  actions?: MenuItem[];
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
  const { port, git, cmux, github, cwd, defaultSurfaceId } = deps;
  const securityConfig = { port };

  function resolveSurfaceId(surfaceId?: string): string | undefined {
    return surfaceId ?? defaultSurfaceId;
  }

  // Map<ws, lastPongTimestamp>
  const wsClients = new Map<ServerWebSocket<unknown>, number>();
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

  // Cached GitHub data — updated by polling, served by API endpoints
  let cachedPR: Awaited<ReturnType<typeof github.getCurrentPR>> = null;
  let cachedChecks: Awaited<ReturnType<typeof github.getCIChecks>> = [];
  let cachedComments: Awaited<ReturnType<typeof github.getPRComments>> = [];

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function pollGitHub() {
    let pr: Awaited<ReturnType<typeof github.getCurrentPR>>;
    try {
      const branch = await git.getCurrentBranch();
      pr = await github.getCurrentPR(branch);
    } catch {
      // API error (network, auth, etc.) — keep cached values, skip update
      return;
    }
    cachedPR = pr;
    if (!pr) {
      cachedChecks = [];
      cachedComments = [];
      const message = JSON.stringify({
        type: "pr-updated",
        data: { pr: null, checks: [], comments: [] },
      });
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
      return;
    }
    try {
      const [checks, comments] = await Promise.all([
        github.getCIChecks({ prNumber: pr.number }),
        github.getPRComments(pr.number),
      ]);
      cachedChecks = checks;
      cachedComments = comments;
      const message = JSON.stringify({
        type: "pr-updated",
        data: { pr, checks, comments },
      });
      for (const ws of wsClients.keys()) {
        ws.send(message);
      }
    } catch {
      // CI/comments fetch error — keep PR info but don't update checks/comments
    }
  }

  function startPolling() {
    if (pollTimer) return;
    // Fetch immediately, then poll every 10s
    pollGitHub();
    pollTimer = setInterval(pollGitHub, 10000);
  }

  function addSecurityHeaders(response: Response): Response {
    const headers = { ...securityHeaders(), ...corsHeaders(securityConfig) };
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  function jsonResponse(data: unknown, status = 200): Response {
    return addSecurityHeaders(Response.json(data, { status }));
  }

  function errorResponse(message: string, status = 500): Response {
    return jsonResponse({ error: message }, status);
  }

  const apiRoutes: Record<string, unknown> = {
    "/api/diff": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const url = new URL(req.url);
          const base = url.searchParams.get("base") ?? undefined;
          const target = url.searchParams.get("target") ?? undefined;
          const raw = await git.getDiff(base, target);
          const files = await highlightDiffFiles(parseDiff(raw));
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
        try {
          const range = await git.computeDiffRange();
          const tracked = await git.getDiff(range.base);
          const untracked = range.includeUntracked ? await git.getUntrackedDiff() : "";
          const raw = [tracked, untracked].filter(Boolean).join("\n");
          const files = await highlightDiffFiles(parseDiff(raw));
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
        try {
          const url = new URL(req.url);
          const base = url.searchParams.get("base") ?? undefined;
          const target = url.searchParams.get("target") ?? undefined;
          const files = await git.getDiffFiles(base, target);
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
        try {
          const url = new URL(req.url);
          const path = url.searchParams.get("path");
          const start = parseInt(url.searchParams.get("start") ?? "1", 10);
          const end = parseInt(url.searchParams.get("end") ?? "1", 10);
          if (!path) return errorResponse("path required", 400);
          const lines = await git.getFileLines(path, start, end);
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
        try {
          const url = new URL(req.url);
          const count = parseInt(url.searchParams.get("count") ?? "20", 10);
          const commits = await git.getLogEntries(count);
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
        try {
          const url = new URL(req.url);
          const hash = url.searchParams.get("hash");
          if (!hash) return errorResponse("hash required", 400);
          // Reject non-hex strings to prevent command injection via git show
          if (!/^[0-9a-f]{4,40}$/i.test(hash)) return errorResponse("invalid hash", 400);
          const raw = await git.getCommitDiff(hash);
          const files = await highlightDiffFiles(parseDiff(raw));
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
        try {
          const [branches, current] = await Promise.all([
            git.getBranches(),
            git.getCurrentBranch(),
          ]);
          return jsonResponse({ branches, current });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/status": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const [status, branch, planPath] = await Promise.all([
            git.getStatus(),
            git.getCurrentBranch(),
            findPlanFile(cwd).catch(() => null),
          ]);
          return jsonResponse({
            status,
            branch,
            cwd,
            terminalSurface: defaultSurfaceId ?? null,
            actions: deps.actions ?? [],
            hasPlan: planPath !== null,
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
        try {
          const planPath = await findPlanFile(cwd);
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

    "/api/send-to-terminal": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = (await req.json()) as { text: string; surfaceId?: string };
          await cmux.sendText(body.text, resolveSurfaceId(body.surfaceId));
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/comment": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = (await req.json()) as {
            file: string;
            startLine: number;
            endLine: number;
            comment: string;
            surfaceId?: string;
          };
          await cmux.sendComment(
            body.file,
            body.startLine,
            body.endLine,
            body.comment,
            resolveSurfaceId(body.surfaceId),
          );
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/command": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = (await req.json()) as { command: string; surfaceId?: string };
          await cmux.sendCommand(body.command, resolveSurfaceId(body.surfaceId));
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/action": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = (await req.json()) as {
            id: string;
            variables?: Record<string, string>;
            surfaceId?: string;
          };
          const actions = deps.actions ?? [];
          const action = findAction(actions, body.id);
          if (!action) {
            return errorResponse("Action not found: " + body.id, 404);
          }
          const actionType = action.type;

          if (actionType === "shell") {
            // Build env variables: built-in + user-provided (only for shell type)
            const branch = await git.getCurrentBranch().catch(() => "");
            const diffRange = await git.computeDiffRange().catch(() => null);
            const base = diffRange?.base ?? "";
            const builtinVars: Record<string, string> = {
              CMUX_HUB_CWD: cwd,
              CMUX_HUB_GIT_BRANCH: branch,
              CMUX_HUB_GIT_BASE: base,
              CMUX_HUB_PORT: String(securityConfig.port),
              CMUX_HUB_SURFACE_ID: defaultSurfaceId ?? "",
            };
            const allVars = { ...builtinVars, ...body.variables };
            const fullCommand = buildCommandWithEnv(action.command, allVars);
            // Execute directly as subshell on server
            const proc = Bun.spawn(["sh", "-c", fullCommand], {
              cwd,
              stdout: "pipe",
              stderr: "pipe",
            });
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;
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
          if (actionType === "paste") {
            await cmux.sendText(termCommand, resolveSurfaceId(body.surfaceId));
          } else {
            await cmux.sendCommand(termCommand, resolveSurfaceId(body.surfaceId));
          }
          return jsonResponse({ ok: true, command: termCommand });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/pr": {
      GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        return jsonResponse({ pr: cachedPR });
      },
    },

    "/api/pr/comments": {
      GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        return jsonResponse({ comments: cachedComments });
      },
    },

    "/api/ci": {
      GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        return jsonResponse({ checks: cachedChecks });
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
        hasHadClients = true;
        logger.debug("ws open, clients:", wsClients.size);
        if (shutdownTimer) {
          logger.debug("shutdown timer cancelled (new client)");
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
        startPolling();
        startHeartbeat();
      },
      message(_ws: ServerWebSocket<unknown>, _message: string | Buffer) {
        // No client→server messages expected yet
      },
      pong(ws: ServerWebSocket<unknown>) {
        wsClients.set(ws, Date.now());
        logger.debug("ws pong received, clients:", wsClients.size);
      },
      close(ws: ServerWebSocket<unknown>) {
        wsClients.delete(ws);
        logger.debug("ws close, clients:", wsClients.size);
        if (wsClients.size === 0) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          stopHeartbeat();
          // Auto-shutdown when all clients disconnect
          if (hasHadClients && deps.autoShutdownMs !== undefined) {
            logger.debug("shutdown timer started:", deps.autoShutdownMs, "ms");
            shutdownTimer = setTimeout(() => {
              logger.info("All clients disconnected, shutting down.");
              process.exit(0);
            }, deps.autoShutdownMs);
          }
        }
      },
    },

    fetch(req: Request) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(securityConfig),
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

      // In dev mode, return undefined so Bun's dev server can serve compiled assets.
      // In production/compiled mode, assets are embedded in routes, so return 404.
      if (deps.development) return undefined;
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
    },

    /** Fetch GitHub data once (for tests or initial load) */
    pollGitHub,

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      deps.watcher?.stop();
    },
  };
}
