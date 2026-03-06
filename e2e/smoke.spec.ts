import { test, expect } from "@playwright/test";

test("ページを開くと、cmux-hubのタイトルが表示される", async ({ page }) => {
  // トップページにアクセス
  await page.goto("/");
  // ページタイトルを検証
  await expect(page).toHaveTitle("cmux-hub");
});

test("ページを開くと、ツールバーにブランチ名とボタンが表示される", async ({ page }) => {
  // トップページにアクセス
  await page.goto("/");
  const toolbar = page.getByTestId("toolbar");
  // ツールバーが表示されるまで待機
  await expect(toolbar).toBeVisible({ timeout: 5000 });
  // ブランチ名が表示されている
  await expect(toolbar).toContainText("feature/test");
  // 操作ボタンが表示されている
  await expect(toolbar.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Commit" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Create PR" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "AI Review" })).toBeVisible();
});

test("ページを開くと、diff viewにファイル一覧と差分内容が表示される", async ({ page }) => {
  // トップページにアクセス
  await page.goto("/");
  const diffView = page.getByTestId("diff-view");
  // diff viewが表示されるまで待機
  await expect(diffView).toBeVisible({ timeout: 5000 });
  // 変更ファイルが表示されている
  const diffFiles = diffView.getByTestId("diff-file");
  await expect(diffFiles).toHaveCount(2);
  // 各ファイルのパスが表示されている
  await expect(diffFiles.nth(0)).toContainText("src/index.ts");
  await expect(diffFiles.nth(1)).toContainText("src/new.ts");
  // 新規ファイルにはNewバッジが表示されている
  await expect(diffFiles.nth(1)).toContainText("New");
  // 差分の追加行が表示されている
  await expect(diffFiles.nth(0)).toContainText("newModule");
});

test("GET /api/status を呼ぶと、ブランチ名を含むレスポンスが返る", async ({ request }) => {
  // APIにリクエスト
  const res = await request.get("/api/status", {
    headers: { host: "127.0.0.1:14568" },
  });
  // 正常レスポンスを検証
  expect(res.ok()).toBe(true);
  const data = await res.json();
  expect(data.branch).toBe("feature/test");
});
