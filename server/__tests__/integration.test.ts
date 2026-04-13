import { serve } from "bun";
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createAppConfig } from "../app.ts";
import { createGitService, type CommandRunner } from "../git.ts";
import { createCmuxService, createDryRunConnector } from "../cmux.ts";
import { createGitHubService } from "../github.ts";

const FAKE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { serve } from "bun";
+import { addedModule } from "./new";

 const server = serve({`;

const PORT = 14567;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function validHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${PORT}`,
    ...extra,
  };
}

function createFakeRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd) => {
    calls.push(cmd);
    const key = cmd.join(" ");
    if (key === "git rev-parse HEAD") return "abc123\n";
    if (key.includes("rev-parse --abbrev-ref HEAD")) return "feature/test\n";
    if (key.includes("symbolic-ref")) return "origin/main\n";
    if (key.includes("merge-base")) return "abc123\n";
    if (key.includes("diff --unified=3")) return FAKE_DIFF;
    if (key.includes("diff --name-only")) return "src/index.ts\n";
    if (key.includes("branch -a")) return "main\nfeature/test\n";
    if (key.includes("status --porcelain")) return "M src/index.ts\n";
    if (key.includes("gh api repos/") && key.includes("/pulls") && !key.includes("reviews"))
      return JSON.stringify([
        {
          number: 42,
          title: "Test PR",
          state: "open",
          merged_at: null,
          html_url: "https://github.com/test/repo/pull/42",
          head: { ref: "feature/test" },
          base: { ref: "main" },
          body: "PR body",
        },
      ]);
    if (key.includes("gh repo view"))
      return JSON.stringify({ owner: { login: "test" }, name: "repo" });
    if (key.includes("gh api graphql") && key.includes("reviewThreads"))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [] } },
          },
        },
      });
    if (key.includes("gh api graphql") && key.includes("statusCheckRollup"))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              name: "ci",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                              detailsUrl: "https://example.com",
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    if (key.includes("gh api") && key.includes("comments")) return "";
    throw new Error(`Unexpected command: ${key}`);
  };
  return { runner, calls };
}

let server_: ReturnType<typeof serve>;
let app: ReturnType<typeof createAppConfig>;
let sentTexts: string[];

beforeAll(async () => {
  const { runner } = createFakeRunner();
  sentTexts = [];

  const git = createGitService(runner, "/tmp/test");
  const cmux = createCmuxService(createDryRunConnector());
  // Intercept cmux sendText
  const originalSendText = cmux.sendText.bind(cmux);
  cmux.sendText = async (text, surfaceId) => {
    sentTexts.push(text);
    return originalSendText(text, surfaceId);
  };
  const github = createGitHubService(runner, "/tmp/test");

  app = createAppConfig({
    port: PORT,
    git,
    cmux,
    github,
    cwd: "/tmp/test",
  });

  server_ = serve({
    port: PORT,
    hostname: "127.0.0.1",
    routes: app.apiRoutes as Parameters<typeof serve>[0]["routes"],
    websocket: app.websocket,
    fetch: app.fetch,
    development: false,
  });

  app.setServer(server_);
  await app.pollGitHub();
});

afterAll(() => {
  app.stop();
  server_.stop(true);
});

describe("API integration", () => {
  // GET endpoints

  test("GET /api/status returns status and branch", async () => {
    const res = await fetch(`${BASE_URL}/api/status`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe("feature/test");
    expect(data.status).toContain("M src/index.ts");
    expect(data.cwd).toBe("/tmp/test");
  });

  test("GET /api/diff returns diff output", async () => {
    const res = await fetch(`${BASE_URL}/api/diff?base=abc123`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.diff).toContain("diff --git");
    expect(data.diff).toContain("addedModule");
  });

  test("GET /api/diff/auto returns auto-detected diff", async () => {
    const res = await fetch(`${BASE_URL}/api/diff/auto`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.diff).toBeDefined();
    expect(data.base).toBeDefined();
  });

  test("GET /api/diff/files returns file list", async () => {
    const res = await fetch(`${BASE_URL}/api/diff/files`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toContain("src/index.ts");
  });

  test("GET /api/branches returns branches and current", async () => {
    const res = await fetch(`${BASE_URL}/api/branches`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branches).toContain("main");
    expect(data.current).toBe("feature/test");
  });

  test("GET /api/pr returns PR info", async () => {
    const res = await fetch(`${BASE_URL}/api/pr`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pr.number).toBe(42);
    expect(data.pr.title).toBe("Test PR");
  });

  test("GET /api/pr/comments returns comments", async () => {
    const res = await fetch(`${BASE_URL}/api/pr/comments`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comments).toBeArray();
  });

  test("GET /api/ci returns CI checks", async () => {
    const res = await fetch(`${BASE_URL}/api/ci`, { headers: validHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0].name).toBe("ci");
  });

  // POST endpoints

  test("POST /api/send-to-terminal sends text via cmux", async () => {
    sentTexts.length = 0;
    const res = await fetch(`${BASE_URL}/api/send-to-terminal`, {
      method: "POST",
      headers: validHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "hello terminal" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(sentTexts).toContain("hello terminal");
  });

  test("POST /api/comment sends formatted comment via cmux", async () => {
    sentTexts.length = 0;
    const res = await fetch(`${BASE_URL}/api/comment`, {
      method: "POST",
      headers: validHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        file: "src/index.ts",
        startLine: 42,
        endLine: 42,
        comment: "fix this",
      }),
    });
    expect(res.status).toBe(200);
    expect(sentTexts[0]).toContain("src/index.ts:42");
    expect(sentTexts[0]).toContain("fix this");
  });

  test("POST /api/command sends command via cmux", async () => {
    sentTexts.length = 0;
    const res = await fetch(`${BASE_URL}/api/command`, {
      method: "POST",
      headers: validHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ command: "echo hello" }),
    });
    expect(res.status).toBe(200);
    expect(sentTexts[0]).toContain("echo hello");
  });

  // Security

  test("rejects requests with invalid host header", async () => {
    const res = await fetch(`${BASE_URL}/api/status`, {
      headers: { host: "evil.com" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects POST with cross-origin sec-fetch-site", async () => {
    const res = await fetch(`${BASE_URL}/api/send-to-terminal`, {
      method: "POST",
      headers: validHeaders({
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      }),
      body: JSON.stringify({ text: "hack" }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects requests with invalid origin", async () => {
    const res = await fetch(`${BASE_URL}/api/status`, {
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: "http://evil.com",
      },
    });
    expect(res.status).toBe(403);
  });

  // Response headers

  test("responses include security headers", async () => {
    const res = await fetch(`${BASE_URL}/api/status`, { headers: validHeaders() });
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("OPTIONS returns CORS headers", async () => {
    const res = await fetch(`${BASE_URL}/api/status`, {
      method: "OPTIONS",
      headers: validHeaders(),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(`http://localhost:${PORT}`);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
