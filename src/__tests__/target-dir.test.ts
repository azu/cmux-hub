import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../../server/git.ts";
import { isLinkedWorktree, resolveTargetDir } from "../lib/target-dir.ts";

function gitDirs(gitDir: string, commonDir: string): CommandRunner {
  return async () => `${gitDir}\n${commonDir}\n`;
}

describe("isLinkedWorktree", () => {
  test("detects a linked worktree", async () => {
    const result = await isLinkedWorktree(
      gitDirs("/repo/.git/worktrees/feature", "/repo/.git"),
      "/worktrees/feature",
    );
    expect(result).toBe(true);
  });

  test("does not treat the main worktree as a linked worktree", async () => {
    const result = await isLinkedWorktree(gitDirs(".git", ".git"), "/repo");
    expect(result).toBe(false);
  });

  test("returns false outside a git repository", async () => {
    const run: CommandRunner = async () => {
      throw new Error("not a git repository");
    };
    expect(await isLinkedWorktree(run, "/tmp")).toBe(false);
  });
});

describe("resolveTargetDir", () => {
  test("prefers an explicit target", async () => {
    const result = await resolveTargetDir({
      explicitTarget: "/explicit",
      processCwd: "/worktrees/feature",
      run: gitDirs("/repo/.git/worktrees/feature", "/repo/.git"),
      getFocusedCwd: async () => "/repo",
    });
    expect(result).toBe("/explicit");
  });

  test("prefers the process cwd when launched from a linked worktree", async () => {
    const result = await resolveTargetDir({
      processCwd: "/worktrees/feature",
      run: gitDirs("/repo/.git/worktrees/feature", "/repo/.git"),
      getFocusedCwd: async () => "/repo",
    });
    expect(result).toBe("/worktrees/feature");
  });

  test("uses the focused cmux cwd for a regular working tree", async () => {
    const result = await resolveTargetDir({
      processCwd: "/launcher",
      run: gitDirs(".git", ".git"),
      getFocusedCwd: async () => "/repo",
    });
    expect(result).toBe("/repo");
  });

  test("falls back to the process cwd when cmux has no focused cwd", async () => {
    const result = await resolveTargetDir({
      processCwd: "/launcher",
      run: gitDirs(".git", ".git"),
      getFocusedCwd: async () => undefined,
    });
    expect(result).toBe("/launcher");
  });
});
