/**
 * Test server for E2E tests.
 * Creates a temporary dirty git repository with real git commands.
 */
import { serve } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import index from "../src/index.html";
import { createAppConfig } from "../server/app.ts";
import { createGitService, defaultCommandRunner } from "../server/git.ts";
import { createCmuxService, createDryRunConnector } from "../server/cmux.ts";
import { createGitHubService } from "../server/github.ts";
import { createFileWatcher, defaultWatcherFactory } from "../server/watcher.ts";

const PORT = 14568;

// Create a temporary dirty git repo
const repoDir = mkdtempSync(join(tmpdir(), "cmux-hub-e2e-"));

function gitInRepo(cmd: string) {
  execSync(`git ${cmd}`, { cwd: repoDir, stdio: "pipe" });
}

// Initialize repo with a base commit
gitInRepo("init");
gitInRepo("config user.email 'test@test.com'");
gitInRepo("config user.name 'Test'");
writeFileSync(join(repoDir, "hello.ts"), 'export const greeting = "hello";\n');
gitInRepo("add .");
gitInRepo("commit -m 'initial commit'");

// Create a feature branch with changes
gitInRepo("checkout -b feature/test");
writeFileSync(
  join(repoDir, "hello.ts"),
  'export const greeting = "hello world";\nexport const version = 1;\n',
);
writeFileSync(join(repoDir, "new-file.ts"), 'export function newModule() {\n  return "new";\n}\n');
// Add a large file to enable scroll position testing
const largeFileLines = Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i};`).join(
  "\n",
);
writeFileSync(join(repoDir, "large-file.ts"), largeFileLines + "\n");
gitInRepo("add .");

// Export repoDir so tests can modify files
export { repoDir };

const git = createGitService(defaultCommandRunner, repoDir);
const cmux = createCmuxService(createDryRunConnector());
const github = createGitHubService(defaultCommandRunner, repoDir);
const watcher = createFileWatcher(defaultWatcherFactory, repoDir);

const app = createAppConfig({
  port: PORT,
  git,
  cmux,
  github,
  cwd: repoDir,
  watcher,
  defaultSurfaceId: "surface:e2e-test",
});

const server = serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    ...app.apiRoutes,
    "/": index,
  },
  websocket: app.websocket,
  fetch: app.fetch,
  development: false,
});

app.setServer(server);
app.startWatcher();

console.log(`E2E test server running at http://127.0.0.1:${PORT}`);
console.log(`Test repo: ${repoDir}`);
