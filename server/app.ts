import { serve, type ServerWebSocket, type Server } from "bun";
import type { GitService } from "./git.ts";
import type { CmuxService } from "./cmux.ts";
import type { GitHubService } from "./github.ts";
import {
  validateRequest,
  securityHeaders,
  corsHeaders,
  isValidWebSocketOrigin,
} from "./middleware/security.ts";

type AppDeps = {
  port: number;
  hostname?: string;
  git: GitService;
  cmux: CmuxService;
  github: GitHubService;
  cwd: string;
  watcher?: {
    start(): void;
    onChanged(cb: () => void): void;
    stop(): void;
  };
  htmlEntry?: unknown;
};

export function createApp(deps: AppDeps) {
  const { port, git, cmux, github, cwd } = deps;
  const hostname = deps.hostname ?? "127.0.0.1";
  const securityConfig = { port };

  const wsClients = new Set<ServerWebSocket<unknown>>();

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const pr = await github.getCurrentPR();
        if (!pr) return;
        const checks = await github.getCIChecks();
        const comments = await github.getPRComments(pr.number);
        const message = JSON.stringify({
          type: "pr-updated",
          data: { pr, checks, comments },
        });
        for (const ws of wsClients) {
          ws.send(message);
        }
      } catch {
        // ignore polling errors
      }
    }, 10000);
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

  // eslint-disable-next-line prefer-const
  let serverRef: Server<unknown>;

  const routes: Record<string, unknown> & { "/"?: unknown } = {
    "/api/diff": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const url = new URL(req.url);
          const base = url.searchParams.get("base") ?? undefined;
          const target = url.searchParams.get("target") ?? undefined;
          const diff = await git.getDiff(base, target);
          return jsonResponse({ diff });
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
          const diff = await git.getDiff(range.base);
          return jsonResponse({ diff, base: range.base, includeUntracked: range.includeUntracked });
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

    "/api/branches": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const branches = await git.getBranches();
          const current = await git.getCurrentBranch();
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
          const status = await git.getStatus();
          const branch = await git.getCurrentBranch();
          return jsonResponse({ status, branch, cwd });
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
          const body = await req.json() as { text: string; surfaceId?: string };
          await cmux.sendText(body.text, body.surfaceId);
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
          const body = await req.json() as {
            file: string;
            line: number;
            comment: string;
            surfaceId?: string;
          };
          await cmux.sendComment(body.file, body.line, body.comment, body.surfaceId);
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
          const body = await req.json() as { command: string; surfaceId?: string };
          await cmux.sendCommand(body.command, body.surfaceId);
          return jsonResponse({ ok: true });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/commit": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = await req.json() as { message: string; surfaceId?: string };
          const command = github.buildCommitCommand(body.message);
          await cmux.sendCommand(command, body.surfaceId);
          return jsonResponse({ ok: true, command });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/pr/create": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = await req.json() as { title: string; body?: string; surfaceId?: string };
          const command = github.buildCreatePRCommand(body.title, body.body);
          await cmux.sendCommand(command, body.surfaceId);
          return jsonResponse({ ok: true, command });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/pr": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const pr = await github.getCurrentPR();
          return jsonResponse({ pr });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/pr/comments": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const pr = await github.getCurrentPR();
          if (!pr) return jsonResponse({ comments: [] });
          const comments = await github.getPRComments(pr.number);
          return jsonResponse({ comments });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/ci": {
      async GET(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const checks = await github.getCIChecks();
          return jsonResponse({ checks });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },

    "/api/review/start": {
      async POST(req: Request) {
        const secErr = validateRequest(req, securityConfig);
        if (secErr) return secErr;
        try {
          const body = await req.json() as { prompt?: string; surfaceId?: string };
          const prompt = body.prompt ?? "このPRの変更をレビューしてください";
          const command = `claude "${prompt}"`;
          await cmux.sendCommand(command, body.surfaceId);
          return jsonResponse({ ok: true, command });
        } catch (e) {
          return errorResponse(e instanceof Error ? e.message : "Unknown error");
        }
      },
    },
  };

  if (deps.htmlEntry) {
    routes["/"] = deps.htmlEntry;
  }

  serverRef = serve({
    port,
    hostname,
    // @ts-expect-error -- routes built dynamically from deps
    routes,

    websocket: {
      open(ws) {
        wsClients.add(ws);
        startPolling();
      },
      message(_ws, _message) {
        // No client→server messages expected yet
      },
      close(ws) {
        wsClients.delete(ws);
        if (wsClients.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      },
    },

    fetch(req) {
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
        const upgraded = serverRef.upgrade(req, { data: {} });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Let Bun handle bundled assets (JS/CSS from HTML entry)
      // Return 404 only for known non-asset paths to suppress console errors
      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }
      return undefined;
    },

    development: false,
  });

  // Start watcher if provided
  if (deps.watcher) {
    deps.watcher.start();
    deps.watcher.onChanged(() => {
      const message = JSON.stringify({ type: "diff-updated" });
      for (const ws of wsClients) {
        ws.send(message);
      }
    });
  }

  return {
    server: serverRef,
    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      deps.watcher?.stop();
      serverRef.stop(true);
    },
  };
}
