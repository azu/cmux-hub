import path from "node:path";
import type { CommandRunner } from "../../server/git.ts";

export type ResolveTargetDirOptions = {
  explicitTarget?: string;
  processCwd: string;
  run: CommandRunner;
  getFocusedCwd: () => Promise<string | undefined>;
};

export async function isLinkedWorktree(run: CommandRunner, cwd: string): Promise<boolean> {
  try {
    const output = await run(["git", "rev-parse", "--git-dir", "--git-common-dir"], { cwd });
    const [gitDir, commonDir] = output.trim().split("\n");
    if (!gitDir || !commonDir) return false;
    return path.resolve(cwd, gitDir) !== path.resolve(cwd, commonDir);
  } catch {
    return false;
  }
}

export async function resolveTargetDir(options: ResolveTargetDirOptions): Promise<string> {
  if (options.explicitTarget) return options.explicitTarget;

  if (await isLinkedWorktree(options.run, options.processCwd)) {
    return options.processCwd;
  }

  return (await options.getFocusedCwd()) ?? options.processCwd;
}
