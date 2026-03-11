import { existsSync } from "node:fs";
import { watch } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveBin } from "./git.ts";
import { logger } from "./logger.ts";

export type WatcherCallback = (event: string, filename: string | null) => void;
export type WatcherFactory = (dir: string, callback: WatcherCallback) => { close: () => void };

function getGitIgnored(cwd: string, filenames: string[]): Set<string> {
  if (filenames.length === 0) return new Set();
  try {
    const result = spawnSync(resolveBin("git"), ["check-ignore", ...filenames], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      return new Set(result.stdout.trim().split("\n").filter(Boolean));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function resolveGitDir(cwd: string): string | null {
  try {
    const result = spawnSync(resolveBin("git"), ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status !== 0) return null;
    const gitDir = result.stdout.trim();
    // Absolute or relative path
    if (gitDir.startsWith("/")) return gitDir;
    return `${cwd}/${gitDir}`;
  } catch {
    return null;
  }
}

export const defaultWatcherFactory: WatcherFactory = (dir, callback) => {
  const watchers: { close: () => void }[] = [];

  if (!existsSync(dir)) {
    logger.debug("watcher: dir does not exist, skipping:", dir);
    return { close: () => {} };
  }

  logger.debug("watcher: watching working tree:", dir);
  // Watch working tree (excluding .git internals and node_modules)
  const workTreeWatcher = watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return;
    // Filter .git directories (top-level and nested submodules)
    if (
      filename.includes("/.git/") ||
      filename.includes("\\.git\\") ||
      filename.startsWith(".git/") ||
      filename.startsWith(".git\\")
    ) {
      const isRefChange =
        filename.includes("refs/") ||
        filename.endsWith("HEAD") ||
        filename.endsWith("COMMIT_EDITMSG");
      if (!isRefChange) {
        logger.debug("watcher: ignored .git internal:", filename);
        return;
      }
      logger.debug("watcher: ref change via working tree:", event, filename);
    }
    if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return;
    logger.debug("watcher: file changed:", event, filename);
    callback(event, filename);
  });
  watchers.push({ close: () => workTreeWatcher.close() });

  // For worktrees, .git is a file pointing elsewhere — watch the actual git dir for ref changes
  const gitDir = resolveGitDir(dir);
  if (gitDir && !gitDir.startsWith(dir + "/") && !gitDir.startsWith(dir + "\\")) {
    logger.debug("watcher: watching git dir (worktree):", gitDir);
    const gitWatcher = watch(gitDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const isRefChange =
        filename.includes("refs/") ||
        filename.endsWith("HEAD") ||
        filename.endsWith("COMMIT_EDITMSG");
      if (!isRefChange) return;
      logger.debug("watcher: ref change via git dir:", event, filename);
      callback(event, filename);
    });
    watchers.push({ close: () => gitWatcher.close() });
  }

  return { close: () => watchers.forEach((w) => w.close()) };
};

export type FileWatcher = ReturnType<typeof createFileWatcher>;

export type ChangeEvent = {
  hasRefChange: boolean;
};
export type ChangeListener = (event: ChangeEvent) => void;

export function createFileWatcher(factory: WatcherFactory, cwd: string) {
  let watcher: { close: () => void } | null = null;
  const listeners = new Set<ChangeListener>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRefChange = false;
  let pendingFiles: string[] = [];

  return {
    start() {
      if (watcher) return;
      logger.debug("fileWatcher: starting for cwd:", cwd);
      watcher = factory(cwd, (_event, filename) => {
        if (filename && (filename.includes("refs/") || filename.endsWith("HEAD"))) {
          logger.debug("fileWatcher: pending ref change:", filename);
          pendingRefChange = true;
        }
        if (filename) {
          pendingFiles.push(filename);
        }
        // Debounce notifications
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Batch gitignore check
          const filesToCheck = pendingFiles;
          pendingFiles = [];
          const ignored = getGitIgnored(cwd, filesToCheck);
          const relevant = filesToCheck.filter((f) => !ignored.has(f));
          if (ignored.size > 0) {
            logger.debug("fileWatcher: ignored (gitignored):", [...ignored]);
          }
          if (relevant.length === 0 && !pendingRefChange) {
            logger.debug("fileWatcher: all files gitignored, skipping notification");
            pendingRefChange = false;
            return;
          }
          const event: ChangeEvent = { hasRefChange: pendingRefChange };
          logger.debug(
            "fileWatcher: notifying",
            listeners.size,
            "listeners, hasRefChange:",
            pendingRefChange,
            "files:",
            relevant,
          );
          pendingRefChange = false;
          for (const listener of listeners) {
            listener(event);
          }
        }, 300);
      });
    },

    stop() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },

    onChanged(listener: ChangeListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
