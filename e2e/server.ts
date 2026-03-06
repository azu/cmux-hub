/**
 * Test server for E2E tests.
 * Uses fake git/cmux/github services with static data.
 */
import index from "../src/index.html";
import { createApp } from "../server/app.ts";
import { createGitService, type CommandRunner } from "../server/git.ts";
import { createCmuxService, createDryRunConnector } from "../server/cmux.ts";
import { createGitHubService } from "../server/github.ts";

const FAKE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 import { serve } from "bun";
+import { newModule } from "./new";

 const server = serve({
-  port: 3000,
+  port: 4567,
   routes: {

diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function newModule() {
+  return "hello";
+}`;

const PORT = 14568;

const runner: CommandRunner = async (cmd) => {
  const key = cmd.join(" ");
  if (key === "git rev-parse HEAD") return "abc123\n";
  if (key.includes("rev-parse --abbrev-ref HEAD")) return "feature/test\n";
  if (key.includes("symbolic-ref")) return "origin/main\n";
  if (key.includes("merge-base")) return "abc123\n";
  if (key.includes("diff --unified=3")) return FAKE_DIFF;
  if (key.includes("diff --name-only")) return "src/index.ts\nsrc/new.ts\n";
  if (key.includes("branch -a")) return "main\nfeature/test\n";
  if (key.includes("status --porcelain")) return "M src/index.ts\nA src/new.ts\n";
  if (key.includes("gh")) return "{}";
  throw new Error(`Unexpected command: ${key}`);
};

const git = createGitService(runner, "/tmp/test");
const cmux = createCmuxService(createDryRunConnector());
const github = createGitHubService(runner, "/tmp/test");

createApp({
  port: PORT,
  git,
  cmux,
  github,
  cwd: "/tmp/test",
  htmlEntry: index,
});

console.log(`E2E test server running at http://127.0.0.1:${PORT}`);
