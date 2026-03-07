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

describe("createGitHubService", () => {
  test("getCurrentPR parses JSON response from gh pr list", async () => {
    const prData = {
      number: 42,
      title: "My PR",
      state: "OPEN",
      url: "https://github.com/test/repo/pull/42",
      headRefName: "feature/x",
      baseRefName: "main",
      body: "Description",
    };
    const runner = createFakeRunner({
      "pr list --head": JSON.stringify([prData]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("feature/x");
    expect(pr).toEqual(prData);
  });

  test("getCurrentPR returns null when no PR exists (empty array)", async () => {
    // gh pr list returns empty array with exit code 0 when no PR exists
    const runner = createFakeRunner({
      "pr list --head": JSON.stringify([]),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR("no-pr-branch");
    expect(pr).toBeNull();
  });

  test("getCurrentPR throws on API errors", async () => {
    // gh pr list returns exit code 1 on real API errors (network, auth)
    const runner: CommandRunner = async () => {
      throw new Error("Command failed: gh pr list\nHTTP 500");
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
      "repo view --json": JSON.stringify({ owner: { login: "test" }, name: "repo" }),
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
      return JSON.stringify([
        {
          number: 1,
          title: "",
          state: "",
          url: "",
          headRefName: "",
          baseRefName: "",
          body: "",
        },
      ]);
    };
    const gh = createGitHubService(runner, "/my/project");
    await gh.getCurrentPR("main");
    expect(capturedCwd).toBe("/my/project");
  });
});
