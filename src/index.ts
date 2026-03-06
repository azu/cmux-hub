import index from "./index.html";
import { createGitService, defaultCommandRunner } from "../server/git.ts";
import { createCmuxService, createSocketConnector, createDryRunConnector } from "../server/cmux.ts";
import { createGitHubService } from "../server/github.ts";
import { createFileWatcher, defaultWatcherFactory } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";

const PORT = parseInt(process.env.PORT ?? "4567", 10);
const CWD = process.env.CMUX_HUB_CWD ?? process.cwd();
const DRY_RUN = process.env.CMUX_HUB_DRY_RUN === "true";

const git = createGitService(defaultCommandRunner, CWD);
const connector = DRY_RUN ? createDryRunConnector() : createSocketConnector();
const cmux = createCmuxService(connector);
const github = createGitHubService(defaultCommandRunner, CWD);
const watcher = createFileWatcher(defaultWatcherFactory, CWD);

createApp({
  port: PORT,
  git,
  cmux,
  github,
  cwd: CWD,
  watcher,
  htmlEntry: index,
});

console.log(`Server running at http://127.0.0.1:${PORT}`);
console.log(`Watching: ${CWD}`);
