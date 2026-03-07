import { watch } from "fs";
import { spawnSync } from "child_process";

export type WatcherCallback = (event: string, filename: string | null) => void;
export type WatcherFactory = (dir: string, callback: WatcherCallback) => { close: () => void };

function resolveGitDir(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf-8" });
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

  // Watch working tree (excluding .git internals and node_modules)
  const workTreeWatcher = watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return;
    if (filename.startsWith(".git/") || filename.startsWith(".git\\")) {
      const isRefChange = filename.includes("refs/") || filename.endsWith("HEAD") || filename.endsWith("COMMIT_EDITMSG");
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
      const isRefChange = filename.includes("refs/") || filename.endsWith("HEAD") || filename.endsWith("COMMIT_EDITMSG");
      if (!isRefChange) return;
      callback(event, filename);
    });
    watchers.push({ close: () => gitWatcher.close() });
  }

  return { close: () => watchers.forEach(w => w.close()) };
};

export type FileWatcher = ReturnType<typeof createFileWatcher>;

export function createFileWatcher(factory: WatcherFactory, cwd: string) {
  let watcher: { close: () => void } | null = null;
  const listeners = new Set<() => void>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    start() {
      if (watcher) return;
      watcher = factory(cwd, (_event, _filename) => {
        // Debounce notifications
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          for (const listener of listeners) {
            listener();
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

    onChanged(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
