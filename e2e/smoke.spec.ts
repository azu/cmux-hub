import { test, expect } from "@playwright/test";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Resolve repo dir from the test server's /api/status endpoint
async function getRepoDir(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/api/status", {
    headers: { host: "127.0.0.1:14568" },
  });
  const data = await res.json();
  return data.cwd as string;
}

test("opening the page shows the branch name in the toolbar", async ({ page }) => {
  await page.goto("/");
  const toolbar = page.getByTestId("toolbar");
  await expect(toolbar).toBeVisible();
  // Branch name is displayed
  await expect(toolbar).toContainText("feature/test");
  // Refresh button is displayed
  await expect(toolbar.getByRole("button", { name: "Refresh" })).toBeVisible();
});

test("opening the page fetches /api/diff/auto and shows changed files", async ({ page }) => {
  // Intercept /api/diff/auto to verify it's called
  let diffRequested = false;
  await page.route("**/api/diff/auto", async (route) => {
    diffRequested = true;
    await route.continue();
  });
  await page.goto("/");
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  // Two changed files are displayed
  const diffFiles = diffView.getByTestId("diff-file");
  await expect(diffFiles).toHaveCount(2);
  // File paths are shown
  await expect(diffFiles.nth(0)).toContainText("hello.ts");
  await expect(diffFiles.nth(1)).toContainText("new-file.ts");
  // New file has the New badge
  await expect(diffFiles.nth(1)).toContainText("New");
  // Added line content is visible
  await expect(diffFiles.nth(0)).toContainText("hello world");
  // Verify the diff API was called
  expect(diffRequested).toBe(true);
});

test("modifying a file updates the diff view automatically", async ({ page, request }) => {
  const repoDir = await getRepoDir(request);
  await page.goto("/");
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  // Verify initial file count
  await expect(diffView.getByTestId("diff-file")).toHaveCount(2);
  // Add a new file to the repo
  writeFileSync(join(repoDir, "added.ts"), "export const added = true;\n");
  execSync("git add added.ts", { cwd: repoDir, stdio: "pipe" });
  // Wait for the diff view to update (watcher debounce + fetch)
  await expect(diffView.getByTestId("diff-file")).toHaveCount(3);
  // The added file is shown
  await expect(diffView).toContainText("added.ts");
});

test("clicking Refresh re-fetches the diff", async ({ page, request }) => {
  const repoDir = await getRepoDir(request);
  await page.goto("/");
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  // Add a new file to the repo
  writeFileSync(join(repoDir, "refreshed.ts"), "export const refreshed = true;\n");
  execSync("git add refreshed.ts", { cwd: repoDir, stdio: "pipe" });
  // Click the Refresh button
  await page.getByTestId("toolbar").getByRole("button", { name: "Refresh" }).click();
  // The added file appears
  await expect(diffView).toContainText("refreshed.ts");
});

test("clicking a diff line opens the comment form, and submitting sends the comment", async ({
  page,
}) => {
  // Intercept /api/comment to verify the request payload
  let commentPayload: Record<string, unknown> | null = null;
  await page.route("**/api/comment", async (route) => {
    const request = route.request();
    commentPayload = request.postDataJSON();
    await route.continue();
  });
  await page.goto("/");
  const diffView = page.getByTestId("diff-view");
  await expect(diffView).toBeVisible();
  // Find the hello.ts file by its header text
  const helloFile = diffView.getByTestId("diff-file").filter({ hasText: "hello.ts" });
  await expect(helloFile).toBeVisible();
  // Click on the gutter of the "hello world" line
  const addedLine = helloFile.getByRole("row").filter({ hasText: "hello world" });
  await addedLine.getByRole("cell").first().click();
  // Comment form appears
  const commentForm = helloFile.getByRole("textbox");
  await expect(commentForm).toBeVisible();
  // Type a comment and submit
  await commentForm.fill("This looks good");
  await helloFile.getByRole("button", { name: "Send to Terminal" }).click();
  // Comment form disappears after successful submission
  await expect(commentForm).not.toBeVisible();
  // Verify the request was sent with correct payload
  assert(commentPayload !== null, "comment API request was not sent");
  expect((commentPayload as Record<string, unknown>).comment).toBe("This looks good");
  expect((commentPayload as Record<string, unknown>).file).toContain("hello.ts");
});

test("GET /api/status returns the current branch name", async ({ request }) => {
  const res = await request.get("/api/status", {
    headers: { host: "127.0.0.1:14568" },
  });
  expect(res.ok()).toBe(true);
  const data = await res.json();
  expect(data.branch).toBe("feature/test");
});
