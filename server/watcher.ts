import { existsSync } from "node:fs";
import { watch } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveBin } from "./git.ts";

export type WatcherCallback = (event: string, filename: string | null) => void;
export type WatcherFactory = (dir: string, callback: WatcherCallback) => { close: () => void };

function resolveGitDir(cwd: string): string | null {
  try {
    const result = spawnSync(resolveBin("git"), ["rev-parse", "--git-dir"], { cwd, encoding: "utf-8" });
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
    return { close: () => {} };
  }

  // Watch working tree (excluding .git internals and node_modules)
  const workTreeWatcher = watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return;
    if (filename.startsWith(".git/") || filename.startsWith(".git\\")) {
      const isRefChange =
        filename.includes("refs/") ||
        filename.endsWith("HEAD") ||
        filename.endsWith("COMMIT_EDITMSG");
      if (!isRefChange) return;
    }
    if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return;
    callback(event, filename);
  });
  watchers.push({ close: () => workTreeWatcher.close() });

  // For worktrees, .git is a file pointing elsewhere — watch the actual git dir for ref changes
  const gitDir = resolveGitDir(dir);
  if (gitDir && !gitDir.startsWith(dir + "/") && !gitDir.startsWith(dir + "\\")) {
    const gitWatcher = watch(gitDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const isRefChange =
        filename.includes("refs/") ||
        filename.endsWith("HEAD") ||
        filename.endsWith("COMMIT_EDITMSG");
      if (!isRefChange) return;
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

  return {
    start() {
      if (watcher) return;
      watcher = factory(cwd, (_event, filename) => {
        if (filename && (filename.includes("refs/") || filename.endsWith("HEAD"))) {
          pendingRefChange = true;
        }
        // Debounce notifications
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const event: ChangeEvent = { hasRefChange: pendingRefChange };
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
