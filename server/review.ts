import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Default review directory. Any markdown file placed under this directory
 * is automatically shown in cmux-hub's Review view. Intended for AI-generated
 * plans / design docs that the user can review before the work is committed.
 */
export const DEFAULT_REVIEW_DIR = path.join(tmpdir(), "cmux-hub-review");

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
