/**
 * Capture screenshots of each feature for README documentation.
 * Run: bun run screenshots
 * Output: docs/*.png
 */
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const DOCS_DIR = join(import.meta.dirname, "..", "docs", "img");

async function getRepoDir(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/api/status", {
    headers: { host: "127.0.0.1:14568" },
  });
  const data = await res.json();
  return data.cwd as string;
}

test("screenshot: diff view with syntax highlighting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("diff-view")).toBeVisible();
  // Wait for syntax highlighting to render
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(DOCS_DIR, "diff-view.png"), fullPage: true });
});

test("screenshot: review comment on diff line", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("diff-view")).toBeVisible();
  // Find the hello.ts file
  const helloFile = page.getByTestId("diff-file").filter({ hasText: "hello.ts" });
  await expect(helloFile).toBeVisible();
  // Click on a diff line to open comment form
  const addedLine = helloFile.getByRole("row").filter({ hasText: "hello world" });
  await addedLine.getByRole("cell").first().click();
  // Type a comment
  const commentForm = helloFile.getByRole("textbox");
  await expect(commentForm).toBeVisible();
  await commentForm.fill("This greeting should be localized for i18n support");
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(DOCS_DIR, "review-comment.png"), fullPage: true });
});

test("screenshot: toolbar actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await page.waitForTimeout(300);
  const toolbar = page.getByTestId("toolbar");
  await toolbar.screenshot({ path: join(DOCS_DIR, "toolbar.png") });
});

test("screenshot: commit list", async ({ page, request }) => {
  const repoDir = await getRepoDir(request);
  // Create commits so the list has content
  for (const [name, msg] of [
    ["feature-a.ts", "feat: add feature A"],
    ["feature-b.ts", "fix: update feature B"],
    ["feature-c.ts", "refactor: clean up module C"],
  ] as const) {
    writeFileSync(join(repoDir, name), `export const x = 1;\n`);
    execSync(`git add . && git commit -m '${msg}'`, { cwd: repoDir, stdio: "pipe" });
  }

  await page.goto("/#/commits");
  // Wait for commit list to load
  await expect(page.getByRole("button", { name: /← Back/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(DOCS_DIR, "commit-list.png"), fullPage: true });
});
