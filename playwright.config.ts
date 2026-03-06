import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 15000,
  use: {
    baseURL: "http://127.0.0.1:14568",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "bun run e2e/server.ts",
    port: 14568,
    reuseExistingServer: false,
  },
});
