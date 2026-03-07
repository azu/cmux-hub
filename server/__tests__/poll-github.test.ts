import { test, expect, describe } from "bun:test";
import assert from "node:assert";
import { createAppConfig } from "../app.ts";
import { createGitService, type CommandRunner } from "../git.ts";
import { createCmuxService, createDryRunConnector } from "../cmux.ts";
import { createGitHubService } from "../github.ts";

const PORT = 14599;

function validHeaders(): Record<string, string> {
  return { host: `127.0.0.1:${PORT}` };
}

const PR_DATA = {
  number: 42,
  title: "Test PR",
  state: "OPEN",
  url: "https://github.com/test/repo/pull/42",
  headRefName: "feature/test",
  baseRefName: "main",
  body: "PR body",
};

function createTestApp(ghRunner: CommandRunner) {
  const baseRunner: CommandRunner = async (cmd) => {
    const key = cmd.join(" ");
    if (key === "git rev-parse HEAD") return "abc123\n";
    if (key.includes("rev-parse --abbrev-ref HEAD")) return "feature/test\n";
    if (key.includes("symbolic-ref")) return "origin/main\n";
    if (key.includes("merge-base")) return "abc123\n";
    if (key.includes("diff")) return "";
    if (key.includes("branch -a")) return "main\n";
    if (key.includes("status --porcelain")) return "";
    // Delegate gh commands to ghRunner
    if (key.startsWith("gh ")) return ghRunner(cmd);
    throw new Error(`Unexpected command: ${key}`);
  };

  const git = createGitService(baseRunner, "/tmp/test");
  const cmux = createCmuxService(createDryRunConnector());
  const github = createGitHubService(ghRunner, "/tmp/test");

  return createAppConfig({ port: PORT, git, cmux, github, cwd: "/tmp/test" });
}

async function getPR(app: ReturnType<typeof createAppConfig>) {
  const handler = (app.apiRoutes["/api/pr"] as { GET: (req: Request) => Response }).GET;
  const res = handler(new Request(`http://127.0.0.1:${PORT}/api/pr`, { headers: validHeaders() }));
  return (await res.json()) as { pr: typeof PR_DATA | null };
}

async function getCI(app: ReturnType<typeof createAppConfig>) {
  const handler = (app.apiRoutes["/api/ci"] as { GET: (req: Request) => Response }).GET;
  const res = handler(new Request(`http://127.0.0.1:${PORT}/api/ci`, { headers: validHeaders() }));
  return (await res.json()) as { checks: unknown[] };
}

describe("pollGitHub cache behavior", () => {
  test("API error preserves cached PR data", async () => {
    let shouldFail = false;
    const ghRunner: CommandRunner = async (cmd) => {
      const key = cmd.join(" ");
      if (key.includes("gh pr list")) {
        if (shouldFail) throw new Error("HTTP 500");
        return JSON.stringify([PR_DATA]);
      }
      if (key.includes("gh repo view"))
        return JSON.stringify({ owner: { login: "test" }, name: "repo" });
      if (key.includes("gh api graphql"))
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        });
      throw new Error(`Unexpected gh command: ${key}`);
    };

    const app = createTestApp(ghRunner);

    // First poll: PR exists
    await app.pollGitHub();
    const before = await getPR(app);
    assert(before.pr !== null);
    expect(before.pr.number).toBe(42);

    // Second poll: API error — cached data should be preserved
    shouldFail = true;
    await app.pollGitHub();
    const after = await getPR(app);
    assert(after.pr !== null);
    expect(after.pr.number).toBe(42);
  });

  test("no PR clears cached data", async () => {
    let hasPR = true;
    const ghRunner: CommandRunner = async (cmd) => {
      const key = cmd.join(" ");
      if (key.includes("gh pr list")) {
        return hasPR ? JSON.stringify([PR_DATA]) : JSON.stringify([]);
      }
      if (key.includes("gh repo view"))
        return JSON.stringify({ owner: { login: "test" }, name: "repo" });
      if (key.includes("gh api graphql"))
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
                                detailsUrl: "",
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        });
      throw new Error(`Unexpected gh command: ${key}`);
    };

    const app = createTestApp(ghRunner);

    // First poll: PR exists with CI checks
    await app.pollGitHub();
    const before = await getPR(app);
    const ciBefore = await getCI(app);
    expect(before.pr).not.toBeNull();
    expect(ciBefore.checks).toHaveLength(1);

    // Second poll: PR no longer exists — cache should be cleared
    hasPR = false;
    await app.pollGitHub();
    const after = await getPR(app);
    const ciAfter = await getCI(app);
    expect(after.pr).toBeNull();
    expect(ciAfter.checks).toHaveLength(0);
  });
});
