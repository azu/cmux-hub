import { watch as fsWatch, existsSync } from "node:fs";
import { logger } from "./logger.ts";

type BroadcastFn = (message: string) => void;
type FsWatcher = { close: () => void };

/**
 * Watch one or more review directories for markdown file changes and
 * broadcast a `review-updated` WebSocket event. The watcher is recursive
 * so newly created files in subdirectories are also observed.
 *
 * Re-resolves periodically so that directories created after startup
 * (e.g. the default tmp dir being recreated) are picked up.
 */
export function createReviewWatcher(reviewDirs: readonly string[], broadcast: BroadcastFn) {
  const watchers = new Map<string, FsWatcher>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveTimer: ReturnType<typeof setInterval> | null = null;

  const notify = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      logger.debug("reviewWatcher: change detected, broadcasting");
      broadcast(JSON.stringify({ type: "review-updated" }));
    }, 300);
  };

  const resolve = () => {
    // Close stale watchers for directories that no longer exist. This
    // happens when a previous session's cleanup removed the default tmp
    // dir, or when the OS tmp reaper deleted it. Without this step the
    // entry stays in `watchers` forever and `watchers.has(dir) === true`
    // below would prevent the re-created dir from ever being re-watched.
    for (const [dir, watcher] of watchers) {
      if (!existsSync(dir)) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watchers.delete(dir);
        logger.debug("reviewWatcher: removed stale watcher for", dir);
      }
    }
    for (const dir of reviewDirs) {
      if (watchers.has(dir)) continue;
      if (!existsSync(dir)) continue;
      try {
        const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
          // Only care about markdown files. `filename` may be null on some
          // platforms; in that case fall through and broadcast anyway.
          if (filename && !filename.endsWith(".md")) return;
          notify();
        });
        watchers.set(dir, watcher);
        logger.debug("reviewWatcher: watching", dir);
      } catch (e) {
        logger.debug("reviewWatcher: failed to watch", dir, e);
      }
    }
  };

  return {
    start() {
      resolve();
      resolveTimer = setInterval(resolve, 30_000);
    },
    stop() {
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      watchers.clear();
      if (resolveTimer) {
        clearInterval(resolveTimer);
        resolveTimer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
  };
}
