import { test, expect, describe } from "bun:test";
import { createGitHubService } from "../github.ts";
import type { CommandRunner } from "../git.ts";

function createFakeRunner(responses: Record<string, string>): CommandRunner {
  return async (cmd) => {
    const key = cmd.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`Unexpected command: ${key}`);
  };
}

const REPO_VIEW = JSON.stringify({ owner: { login: "test" }, name: "repo" });

describe("createGitHubService", () => {
  test("getCurrentPR parses REST API response and normalizes state", async () => {
    const restPR = {
      number: 42,
      title: "My PR",
      state: "open",
      merged_at: null,
      html_url: "https://github.com/test/repo/pull/42",
      head: { ref: "feature/x" },
      base: { ref: "main" },
      body: "Description",
    };
    const runner = createFakeRunner({
      "repo view --json": REPO_VIEW,
      "gh api repos/": JSON.stringify([restPR]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("feature/x");
    expect(pr).toEqual({
      number: 42,
      title: "My PR",
      state: "OPEN",
      url: "https://github.com/test/repo/pull/42",
      headRefName: "feature/x",
      baseRefName: "main",
      body: "Description",
    });
  });

  test("getCurrentPR returns MERGED state when merged_at is set", async () => {
    const restPR = {
      number: 10,
      title: "Merged PR",
      state: "closed",
      merged_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/test/repo/pull/10",
      head: { ref: "feature/merged" },
      base: { ref: "main" },
      body: "",
    };
    const runner = createFakeRunner({
      "repo view --json": REPO_VIEW,
      "gh api repos/": JSON.stringify([restPR]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("feature/merged");
    expect(pr?.state).toBe("MERGED");
  });

  test("getCurrentPR returns CLOSED state for closed non-merged PR", async () => {
    const restPR = {
      number: 11,
      title: "Closed PR",
      state: "closed",
      merged_at: null,
      html_url: "https://github.com/test/repo/pull/11",
      head: { ref: "feature/closed" },
      base: { ref: "main" },
      body: "",
    };
    const runner = createFakeRunner({
      "repo view --json": REPO_VIEW,
      "gh api repos/": JSON.stringify([restPR]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("feature/closed");
    expect(pr?.state).toBe("CLOSED");
  });

  test("getCurrentPR returns null when no PR exists (empty array)", async () => {
    const runner = createFakeRunner({
      "repo view --json": REPO_VIEW,
      "gh api repos/": JSON.stringify([]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("no-pr-branch");
    expect(pr).toBeNull();
  });

  test("getCurrentPR throws on API errors", async () => {
    const runner: CommandRunner = async (cmd) => {
      const key = cmd.join(" ");
      if (key.includes("repo view --json")) return REPO_VIEW;
      throw new Error("HTTP 500");
    };
    const gh = createGitHubService(runner, "/tmp/test");
    await expect(gh.getCurrentPR("some-branch")).rejects.toThrow("HTTP 500");
  });

  test("getCIChecks parses response", async () => {
    const graphqlResponse = {
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
    };
    const runner = createFakeRunner({
      "repo view --json": REPO_VIEW,
      "api graphql": JSON.stringify(graphqlResponse),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const checks = await gh.getCIChecks({ prNumber: 1 });
    expect(checks).toEqual([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.com" },
    ]);
  });

  test("getCIChecks throws on error", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("no checks");
    };
    const gh = createGitHubService(runner, "/tmp/test");
    await expect(gh.getCIChecks({ prNumber: 1 })).rejects.toThrow("no checks");
  });

  test("passes cwd to command runner", async () => {
    let capturedCwd: string | undefined;
    const runner: CommandRunner = async (cmd, options) => {
      capturedCwd = options?.cwd;
      const key = cmd.join(" ");
      if (key.includes("repo view --json")) return REPO_VIEW;
      return JSON.stringify([
        {
          number: 1,
          title: "",
          state: "open",
          merged_at: null,
          html_url: "",
          head: { ref: "" },
          base: { ref: "" },
          body: "",
        },
      ]);
    };
    const gh = createGitHubService(runner, "/my/project");
    await gh.getCurrentPR("main");
    expect(capturedCwd).toBe("/my/project");
  });

  test("caches owner/repo across calls", async () => {
    let repoViewCalls = 0;
    const runner: CommandRunner = async (cmd) => {
      const key = cmd.join(" ");
      if (key.includes("repo view --json")) {
        repoViewCalls++;
        return REPO_VIEW;
      }
      if (key.includes("gh api repos/")) return JSON.stringify([]);
      throw new Error(`Unexpected command: ${key}`);
    };
    const gh = createGitHubService(runner, "/tmp/test");
    await gh.getCurrentPR("branch-1");
    await gh.getCurrentPR("branch-2");
    expect(repoViewCalls).toBe(1);
  });
});
