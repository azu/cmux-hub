import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Root directory that holds per-instance review subdirectories.
 * Each cmux-hub instance gets its own subdirectory so that multiple
 * instances (different cmux surfaces / sessions) never mix their files.
 */
export const REVIEW_ROOT = path.join(tmpdir(), "cmux-hub-review");

/**
 * Pick a stable sub-directory name for this cmux-hub instance.
 *
 * Preference order:
 *   1. Explicit `overrideId` — caller-resolved binding
 *   2. `CMUX_WORKSPACE_ID` — the cmux workspace (sidebar entry, shown as a
 *      "tab" in the UI). One workspace represents one project / work context,
 *      and stays stable even when the user adds panes or surfaces within it.
 *      This is the preferred granularity: a plan written while Claude runs in
 *      a terminal surface is also visible when cmux-hub's browser surface is
 *      in a different pane of the same workspace.
 *   3. `CMUX_SURFACE_ID` — per-surface fallback (finer-grained than workspace).
 *   4. Process PID — last-resort unique value when cmux env is absent.
 *
 * See https://cmux.com/ja/docs/concepts for the cmux hierarchy
 *   Window > Workspace > Pane > Surface > Panel
 */
export function resolveDefaultReviewDir(options: {
  overrideId?: string;
  workspaceId?: string;
  surfaceId?: string;
  pid?: number;
} = {}): string {
  const overrideId = options.overrideId;
  if (overrideId) {
    return path.join(REVIEW_ROOT, sanitizeSegment(overrideId));
  }
  const workspaceId = options.workspaceId ?? process.env.CMUX_WORKSPACE_ID;
  if (workspaceId) {
    return path.join(REVIEW_ROOT, `workspace-${sanitizeSegment(workspaceId)}`);
  }
  const surfaceId = options.surfaceId ?? process.env.CMUX_SURFACE_ID;
  if (surfaceId) {
    return path.join(REVIEW_ROOT, `surface-${sanitizeSegment(surfaceId)}`);
  }
  const pid = options.pid ?? process.pid;
  return path.join(REVIEW_ROOT, `pid-${pid}`);
}

/**
 * Strip path separators and other characters that could escape the review root.
 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export type ReviewFileInfo = {
  /** Absolute path of the markdown file */
  path: string;
  /** Relative path from the review directory it belongs to */
  relativePath: string;
  /** mtime in ms (for sorting newest-first) */
  mtime: number;
};

/**
 * Normalize and de-duplicate a list of review directory paths.
 * Missing directories are skipped unless `createIfMissing` is true.
 */
export function resolveReviewDirs(
  dirs: readonly string[],
  options: { createIfMissing?: boolean } = {},
): string[] {
  const resolved = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    const abs = path.resolve(dir);
    if (!existsSync(abs)) {
      if (options.createIfMissing) {
        try {
          mkdirSync(abs, { recursive: true });
        } catch {
          continue;
        }
      } else {
        continue;
      }
    }
    resolved.add(abs);
  }
  return [...resolved];
}

/**
 * Check whether an absolute path lives inside one of the allowed review dirs.
 * Used as a guard for any endpoint that reads files by caller-supplied path.
 */
export function isPathInsideReviewDirs(
  filePath: string,
  reviewDirs: readonly string[],
): boolean {
  const abs = path.resolve(filePath);
  for (const dir of reviewDirs) {
    const root = path.resolve(dir);
    // Ensure we compare complete path segments (avoid /tmp/foo matching /tmp/foobar)
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs === root || abs.startsWith(rootWithSep)) return true;
  }
  return false;
}

/**
 * List all markdown files under the given review directories, newest first.
 */
export async function listReviewFiles(
  reviewDirs: readonly string[],
): Promise<ReviewFileInfo[]> {
  const entries: ReviewFileInfo[] = [];
  const glob = new Bun.Glob("**/*.md");
  for (const dir of reviewDirs) {
    if (!existsSync(dir)) continue;
    for await (const rel of glob.scan({ cwd: dir })) {
      const abs = path.join(dir, rel);
      try {
        const stat = await Bun.file(abs).stat();
        entries.push({
          path: abs,
          relativePath: rel,
          mtime: stat.mtime.getTime(),
        });
      } catch {
        // File disappeared between scan and stat — skip it
      }
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/**
 * Remove a directory tree. Used at shutdown to clean up per-instance dirs.
 * Safe: silently ignores missing paths and permission errors.
 */
export function removeDirSafe(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore — best-effort cleanup
  }
}
