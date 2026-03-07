#!/usr/bin/env bun
import { serve } from "bun";
import { parseArgs } from "node:util";
import index from "./index.html";
import { createGitService, defaultCommandRunner } from "../server/git.ts";
import { createCmuxService, createSocketConnector, createDryRunConnector } from "../server/cmux.ts";
import { createGitHubService } from "../server/github.ts";
import { createFileWatcher, defaultWatcherFactory } from "../server/watcher.ts";
import { createAppConfig } from "../server/app.ts";
import { logger, enableDebug } from "../server/logger.ts";
import { loadActions, DEFAULT_ACTIONS } from "../server/actions.ts";
import type { MenuItem } from "../server/actions.ts";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: process.env.PORT ?? "0" },
    "dry-run": { type: "boolean", default: process.env.CMUX_HUB_DRY_RUN === "true" },
    actions: { type: "string", short: "a" },
    debug: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (positionals[0] === "update") {
  const { runUpdateSafe } = await import("../server/updater.ts");
  await runUpdateSafe();
  process.exit(0);
}

if (values.help) {
  console.log(`cmux-hub - Diff viewer for cmux

Usage: cmux-hub [command] [options] [target_dir]

Commands:
  update                 Update cmux-hub to the latest version

Options:
  -p, --port <port>      Server port (default: random)
  -a, --actions <file>   JSON file for toolbar actions (use - for stdin)
  --dry-run              Don't connect to cmux socket
  --debug                Enable debug logging
  -h, --help             Show this help

Examples:
  cmux-hub                              # Use current directory
  cmux-hub /path/to/project             # Specify target directory
  cmux-hub --actions actions.json       # Custom toolbar actions
  cat actions.json | cmux-hub -a -      # Read actions from stdin
  cmux-hub --dry-run                    # Development mode
  cmux-hub update                       # Update to latest version`);
  process.exit(0);
}

if (values.debug) {
  enableDebug();
}

const PORT = parseInt(values.port ?? "0", 10);
const DRY_RUN = values["dry-run"] ?? false;

// Resolve terminal surface: env var → cmux identify (focused surface)
async function resolveTerminalSurface(): Promise<string | undefined> {
  if (process.env.CMUX_SURFACE_ID) return process.env.CMUX_SURFACE_ID;
  try {
    const proc = Bun.spawn([CMUX_BIN, "--json", "identify"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return undefined;
    const data = JSON.parse(output) as { focused?: { surface_ref?: string } };
    const ref = data.focused?.surface_ref;
    if (ref) {
      logger.debug("auto-detected terminal surface:", ref);
      return ref;
    }
  } catch {
    // cmux not available
  }
  return undefined;
}

const TERMINAL_SURFACE = await resolveTerminalSurface();

// Load actions. Cache in globalThis for bun --hot (stdin can only be read once)
let actions: MenuItem[] = DEFAULT_ACTIONS;
if (values.actions) {
  const g = globalThis as Record<string, unknown>;
  if (g.__cmuxHubActions) {
    actions = g.__cmuxHubActions as MenuItem[];
  } else {
    try {
      actions = await loadActions(values.actions);
      g.__cmuxHubActions = actions;
      logger.debug("loaded", actions.length, "actions from", values.actions);
    } catch (e) {
      console.error("Failed to load actions:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }
}

// Determine target directory
async function resolveTargetDir(): Promise<string> {
  if (positionals.length > 0) {
    return positionals[0]!;
  }

  // Try cmux sidebar-state for focused pane cwd
  try {
    const proc = Bun.spawn([CMUX_BIN, "sidebar-state"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const match = /^focused_cwd=(.+)$/m.exec(output);
    if (match?.[1]) return match[1];
  } catch {
    // cmux not available
  }

  return process.cwd();
}

const CWD = await resolveTargetDir();

// Notify via cmux
try {
  Bun.spawn([CMUX_BIN, "notify", "--title", "cmux-hub", "--body", `Loading diff: ${CWD}`], {
    stderr: "pipe",
  });
} catch {
  // cmux not available
}

const git = createGitService(defaultCommandRunner, CWD);
const connector = DRY_RUN ? createDryRunConnector() : createSocketConnector();
const cmux = createCmuxService(connector);
const github = createGitHubService(defaultCommandRunner, CWD);
const watcher = createFileWatcher(defaultWatcherFactory, CWD);

const app = createAppConfig({
  port: PORT,
  git,
  cmux,
  github,
  cwd: CWD,
  watcher,
  defaultSurfaceId: TERMINAL_SURFACE,
  // CLI mode: waitForBrowserClose handles shutdown via cmux surface polling
  autoShutdownMs: undefined,
  actions,
});

// Detect dev mode: compiled binary sets Bun.main differently
const isDev = !process.execPath.includes("cmux-hub");

const server = serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    ...app.apiRoutes,
    "/": index,
  },
  websocket: app.websocket,
  fetch: app.fetch,
  development: isDev && {
    hmr: true,
    console: true,
  },
});

app.setServer(server);
app.startWatcher();

// Cleanup on termination signals (e.g. SIGHUP from parent shell exit)
function cleanup() {
  logger.info("cmux-hub: Signal received, shutting down.");
  watcher.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGHUP", cleanup);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

logger.info(`Server running at http://127.0.0.1:${server.port}`);
logger.info(`Watching: ${CWD}`);

// Wait for server to be ready before opening browser
async function waitForReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/status`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
}
await waitForReady();

// Open browser split in cmux
async function openBrowserSplit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [CMUX_BIN, "--json", "browser", "open-split", `http://127.0.0.1:${server.port}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    // Extract surface ref from JSON output
    const match = /"ref"\s*:\s*"(surface:\d+)"/.exec(output);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function isSurfaceAlive(surfaceRef: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([CMUX_BIN, "surface-health"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const alive = output.includes(surfaceRef);
    logger.debug("surface-health check:", surfaceRef, "alive:", alive);
    return alive;
  } catch {
    logger.debug("surface-health check failed");
    return false;
  }
}

async function waitForBrowserClose(surfaceRef: string) {
  logger.debug("watching surface:", surfaceRef);
  while (await isSurfaceAlive(surfaceRef)) {
    await Bun.sleep(1000);
  }
  logger.info("Browser closed, shutting down.");
  process.exit(0);
}

// bun --hot re-executes top-level code on every change.
// Store the browser surface ref in globalThis to avoid opening a new window each time.
const existingSurface = (globalThis as Record<string, unknown>).__cmuxHubBrowserSurface as
  | string
  | undefined;
if (existingSurface) {
  logger.debug("reusing existing browser surface:", existingSurface);
  waitForBrowserClose(existingSurface);
} else {
  const browserSurface = await openBrowserSplit();
  if (browserSurface) {
    (globalThis as Record<string, unknown>).__cmuxHubBrowserSurface = browserSurface;
    waitForBrowserClose(browserSurface);
  } else {
    logger.info("cmux browser split not available, open http://127.0.0.1:" + server.port);
  }
}
