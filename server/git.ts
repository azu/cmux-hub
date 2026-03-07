export type CommandRunner = (cmd: string[], options?: { cwd?: string }) => Promise<string>;

export const defaultCommandRunner: CommandRunner = async (cmd, options) => {
  const proc = Bun.spawn(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
  }
  return stdout;
};

export type GitService = ReturnType<typeof createGitService>;

export function createGitService(run: CommandRunner, cwd: string) {
  const git = (args: string[]) => run(["git", ...args], { cwd });

  return {
    async hasHead(): Promise<boolean> {
      try {
        await git(["rev-parse", "HEAD"]);
        return true;
      } catch {
        return false;
      }
    },

    async getDiff(base?: string, target?: string): Promise<string> {
      if (base && target) {
        return git(["diff", "--unified=3", `${base}...${target}`]);
      }
      if (base) {
        return git(["diff", "--unified=3", base]);
      }
      // No HEAD yet (no commits) → show staged diff
      if (!(await this.hasHead())) {
        return git(["diff", "--unified=3", "--cached"]);
      }
      // working directory diff (staged + unstaged)
      return git(["diff", "--unified=3", "HEAD"]);
    },

    async getDiffFiles(base?: string, target?: string): Promise<string[]> {
      let raw: string;
      if (base && target) {
        raw = await git(["diff", "--name-only", `${base}...${target}`]);
      } else if (base) {
        raw = await git(["diff", "--name-only", base]);
      } else if (!(await this.hasHead())) {
        raw = await git(["diff", "--name-only", "--cached"]);
      } else {
        raw = await git(["diff", "--name-only", "HEAD"]);
      }
      return raw.trim().split("\n").filter(Boolean);
    },

    async getCurrentBranch(): Promise<string> {
      try {
        const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
        return branch.trim();
      } catch {
        // No commits yet
        return "(no commits)";
      }
    },

    async getDefaultBranch(): Promise<string | null> {
      try {
        const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
        return ref.trim();
      } catch {
        // fallback
        try {
          await git(["rev-parse", "--verify", "origin/main"]);
          return "origin/main";
        } catch {
          try {
            await git(["rev-parse", "--verify", "origin/master"]);
            return "origin/master";
          } catch {
            return null;
          }
        }
      }
    },

    async getMergeBase(branch1: string, branch2: string): Promise<string | null> {
      try {
        const base = await git(["merge-base", branch1, branch2]);
        return base.trim();
      } catch {
        return null;
      }
    },

    async getBranches(): Promise<string[]> {
      const raw = await git(["branch", "-a", "--format=%(refname:short)"]);
      return raw.trim().split("\n").filter(Boolean);
    },

    async getStatus(): Promise<string> {
      return git(["status", "--porcelain"]);
    },

    async getLog(count = 10): Promise<string> {
      return git(["log", `--oneline`, `-${count}`]);
    },

    async getLogEntries(count = 20): Promise<Array<{ hash: string; message: string }>> {
      const raw = await git(["log", "--oneline", `-${count}`]);
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          return {
            hash: line.slice(0, spaceIdx),
            message: line.slice(spaceIdx + 1),
          };
        });
    },

    async getCommitDiff(hash: string): Promise<string> {
      return git(["show", "--format=", "--unified=3", hash]);
    },

    async getUntrackedFiles(): Promise<string[]> {
      const raw = await git(["ls-files", "--others", "--exclude-standard"]);
      return raw.trim().split("\n").filter(Boolean);
    },

    async getFileLines(filePath: string, start: number, end: number): Promise<string[]> {
      try {
        // Validate path is within the repository
        const path = await import("path");
        const resolved = path.resolve(cwd, filePath);
        if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
          throw new Error("Path outside repository: " + filePath);
        }
        const content = await run(["cat", resolved], { cwd });
        const lines = content.split("\n");
        // 1-indexed, inclusive
        return lines.slice(start - 1, end);
      } catch {
        return [];
      }
    },

    /**
     * Compute the appropriate diff base for the current branch.
     * Returns { base, target } where target is always "HEAD" or "." (working tree).
     */
    async computeDiffRange(): Promise<{ base: string; includeUntracked: boolean }> {
      if (!(await this.hasHead())) {
        return { base: "--cached", includeUntracked: true };
      }

      const currentBranch = await this.getCurrentBranch();
      const defaultBranch = await this.getDefaultBranch();

      if (!defaultBranch || currentBranch === defaultBranch.replace("origin/", "")) {
        return { base: "HEAD", includeUntracked: true };
      }

      const mergeBase = await this.getMergeBase("HEAD", defaultBranch);
      if (!mergeBase) {
        return { base: "HEAD", includeUntracked: true };
      }

      return { base: mergeBase, includeUntracked: false };
    },
  };
}
