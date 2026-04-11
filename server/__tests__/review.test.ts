import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REVIEW_ROOT,
  isPathInsideReviewDirs,
  listReviewFiles,
  resolveDefaultReviewDir,
  resolveReviewDirs,
  removeDirSafe,
} from "../review.ts";

describe("resolveDefaultReviewDir", () => {
  const originalWorkspace = process.env.CMUX_WORKSPACE_ID;
  const originalSurface = process.env.CMUX_SURFACE_ID;

  beforeEach(() => {
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_SURFACE_ID;
  });

  afterEach(() => {
    if (originalWorkspace !== undefined) process.env.CMUX_WORKSPACE_ID = originalWorkspace;
    else delete process.env.CMUX_WORKSPACE_ID;
    if (originalSurface !== undefined) process.env.CMUX_SURFACE_ID = originalSurface;
    else delete process.env.CMUX_SURFACE_ID;
  });

  test("prefers workspace binding by default", () => {
    const dir = resolveDefaultReviewDir({ workspaceId: "ws-1", surfaceId: "surface:42" });
    expect(dir).toBe(path.join(REVIEW_ROOT, "workspace-ws-1"));
  });

  test("falls back to surface when workspace is absent", () => {
    const dir = resolveDefaultReviewDir({ surfaceId: "surface:42" });
    // Colons are sanitized to underscores because they aren't safe path chars
    expect(dir).toBe(path.join(REVIEW_ROOT, "surface-surface_42"));
  });

  test("honors explicit surface binding", () => {
    const dir = resolveDefaultReviewDir({
      binding: "surface",
      workspaceId: "ws-1",
      surfaceId: "surface:42",
    });
    expect(dir).toBe(path.join(REVIEW_ROOT, "surface-surface_42"));
  });

  test("falls back to pid when no cmux env is available", () => {
    const dir = resolveDefaultReviewDir({ pid: 1234 });
    expect(dir).toBe(path.join(REVIEW_ROOT, "pid-1234"));
  });

  test("overrideId wins over everything", () => {
    const dir = resolveDefaultReviewDir({
      overrideId: "custom",
      workspaceId: "ws-1",
      surfaceId: "s-2",
    });
    expect(dir).toBe(path.join(REVIEW_ROOT, "custom"));
  });

  test("reads from env vars when options are missing", () => {
    process.env.CMUX_WORKSPACE_ID = "envws";
    expect(resolveDefaultReviewDir()).toBe(path.join(REVIEW_ROOT, "workspace-envws"));
    delete process.env.CMUX_WORKSPACE_ID;
    process.env.CMUX_SURFACE_ID = "envsurface";
    expect(resolveDefaultReviewDir()).toBe(path.join(REVIEW_ROOT, "surface-envsurface"));
  });
});

describe("isPathInsideReviewDirs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cmux-hub-review-test-"));

  test("returns true for a file directly under the dir", () => {
    expect(isPathInsideReviewDirs(path.join(root, "plan.md"), [root])).toBe(true);
  });

  test("returns true for nested files", () => {
    expect(isPathInsideReviewDirs(path.join(root, "sub", "nested.md"), [root])).toBe(true);
  });

  test("rejects paths outside the dir", () => {
    expect(isPathInsideReviewDirs("/etc/passwd", [root])).toBe(false);
  });

  test("does not match sibling dirs via prefix overlap", () => {
    const sibling = root + "-other";
    expect(isPathInsideReviewDirs(path.join(sibling, "x.md"), [root])).toBe(false);
  });

  test("rejects empty dir list", () => {
    expect(isPathInsideReviewDirs(path.join(root, "plan.md"), [])).toBe(false);
  });
});

describe("listReviewFiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cmux-hub-review-list-"));
  });

  afterEach(() => {
    removeDirSafe(tmp);
  });

  test("returns empty array for empty dir", async () => {
    expect(await listReviewFiles([tmp])).toEqual([]);
  });

  test("returns markdown files sorted newest first", async () => {
    const older = path.join(tmp, "older.md");
    const newer = path.join(tmp, "newer.md");
    writeFileSync(older, "# older");
    // Ensure the mtime gap is observable
    const past = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(older, past, past);
    writeFileSync(newer, "# newer");

    const entries = await listReviewFiles([tmp]);
    expect(entries.map((e) => e.relativePath)).toEqual(["newer.md", "older.md"]);
  });

  test("includes markdown files in subdirectories", async () => {
    mkdirSync(path.join(tmp, "plans"), { recursive: true });
    writeFileSync(path.join(tmp, "plans", "design.md"), "nested");
    const entries = await listReviewFiles([tmp]);
    expect(entries.map((e) => e.relativePath)).toContain(path.join("plans", "design.md"));
  });

  test("ignores non-markdown files", async () => {
    writeFileSync(path.join(tmp, "notes.txt"), "not markdown");
    writeFileSync(path.join(tmp, "plan.md"), "# plan");
    const entries = await listReviewFiles([tmp]);
    expect(entries.map((e) => e.relativePath)).toEqual(["plan.md"]);
  });
});

describe("resolveReviewDirs", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cmux-hub-review-resolve-"));
  });

  afterEach(() => {
    removeDirSafe(tmp);
  });

  test("skips missing directories when createIfMissing is false", () => {
    const missing = path.join(tmp, "does-not-exist");
    expect(resolveReviewDirs([missing])).toEqual([]);
  });

  test("creates missing directories when asked", () => {
    const missing = path.join(tmp, "to-create");
    const result = resolveReviewDirs([missing], { createIfMissing: true });
    expect(result).toEqual([path.resolve(missing)]);
  });

  test("deduplicates repeated entries", () => {
    const result = resolveReviewDirs([tmp, tmp]);
    expect(result).toEqual([path.resolve(tmp)]);
  });

  test("skips empty strings", () => {
    const result = resolveReviewDirs(["", tmp, ""]);
    expect(result).toEqual([path.resolve(tmp)]);
  });
});
