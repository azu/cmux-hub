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
  test("getCurrentPR parses JSON response", async () => {
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
      "pr view --json": JSON.stringify(prData),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR();
    expect(pr).toEqual(prData);
  });

  test("getCurrentPR returns null when no PR", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("no PR found");
    };
    const gh = createGitHubService(runner, "/tmp/test");
    const pr = await gh.getCurrentPR();
    expect(pr).toBeNull();
  });

  test("getCIChecks parses response", async () => {
    const prData = {
      number: 1,
      title: "PR",
      state: "OPEN",
      url: "",
      headRefName: "feat",
      baseRefName: "main",
      body: "",
    };
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
      "pr view --json": JSON.stringify(prData),
      "repo view --json": JSON.stringify({ owner: { login: "test" }, name: "repo" }),
      "api graphql": JSON.stringify(graphqlResponse),
    });
    const gh = createGitHubService(runner, "/tmp/test");
    const checks = await gh.getCIChecks();
    expect(checks).toEqual([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.com" },
    ]);
  });

  test("getCIChecks returns empty on error", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("no checks");
    };
    const gh = createGitHubService(runner, "/tmp/test");
    const checks = await gh.getCIChecks();
    expect(checks).toEqual([]);
  });

  test("passes cwd to command runner", async () => {
    let capturedCwd: string | undefined;
    const runner: CommandRunner = async (cmd, options) => {
      capturedCwd = options?.cwd;
      return JSON.stringify({
        number: 1,
        title: "",
        state: "",
        url: "",
        headRefName: "",
        baseRefName: "",
        body: "",
      });
    };
    const gh = createGitHubService(runner, "/my/project");
    await gh.getCurrentPR();
    expect(capturedCwd).toBe("/my/project");
  });
});
