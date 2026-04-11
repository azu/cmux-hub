#!/usr/bin/env bun
import { serve } from "bun";
import { parseArgs } from "node:util";
import path from "node:path";
import index from "./index.html";
import { createGitService, defaultCommandRunner } from "../server/git.ts";
import { createCmuxService, createSocketConnector, createDryRunConnector } from "../server/cmux.ts";
import { createGitHubService } from "../server/github.ts";
import { createFileWatcher, defaultWatcherFactory } from "../server/watcher.ts";
import { createAppConfig } from "../server/app.ts";
import { logger, enableDebug } from "../server/logger.ts";
import { loadActions, DEFAULT_ACTIONS } from "../server/actions.ts";
import type { MenuItem } from "../server/actions.ts";
import { loadLaunchJson, createLauncher } from "../server/launcher.ts";
import type { Launcher } from "../server/launcher.ts";
import {
  resolveDefaultReviewDir,
  resolveReviewDirs,
  removeDirSafe,
} from "../server/review.ts";
import pkg from "../package.json" with { type: "json" };

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p", default: process.env.PORT ?? "0" },
    "dry-run": { type: "boolean", default: process.env.CMUX_HUB_DRY_RUN === "true" },
    actions: { type: "string", short: "a" },
    "review-dir": { type: "string", multiple: true },
    debug: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
  allowPositionals: true,
});

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

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
  --review-dir <path>    Directory watched by the Review view (repeatable).
                         Default: \${TMPDIR}/cmux-hub-review/\${CMUX_SURFACE_ID}
  --dry-run              Don't connect to cmux socket
  --debug                Enable debug logging
  -v, --version          Show version
  -h, --help             Show this help

Customizing Toolbar Actions:
  The toolbar menu is configured via .claude/cmux-hub.json in your project.
  The plugin copies a default file on first run. Edit it to add your own actions.

  JSON format — array of ActionItem or SubmenuItem:

    ActionItem:
      {
        "label": "Button Label",
        "command": "command to run",
        "type": "paste-and-enter" | "shell" | "paste",
        "input": { "placeholder": "Prompt text...", "variable": "VAR" }  // optional
      }

    SubmenuItem:
      {
        "label": "Menu Label",
        "submenu": [ ...ActionItem[] ]
      }

  Action types:
    paste-and-enter  Paste command into cmux terminal and press Enter
    shell            Execute as subshell on server (returns stdout/stderr)
    paste            Paste into cmux terminal without pressing Enter

  User input:
    Add "input" to prompt the user for a value before running.
    The variable is injected via env prefix: VAR='value' command.

  Built-in variables (shell type only):
    CMUX_HUB_CWD    Repository working directory

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

// Resolve review directories:
//   - explicit --review-dir flags take precedence (repeatable)
//   - otherwise derive one from cmux workspace / surface env vars
const REVIEW_DIR_OVERRIDES = values["review-dir"] ?? [];
const REVIEW_DIRS = (() => {
  if (REVIEW_DIR_OVERRIDES.length > 0) {
    return resolveReviewDirs(REVIEW_DIR_OVERRIDES, { createIfMissing: true });
  }
  const defaultDir = resolveDefaultReviewDir({ surfaceId: TERMINAL_SURFACE });
  return resolveReviewDirs([defaultDir], { createIfMissing: true });
})();
logger.debug("review dirs:", REVIEW_DIRS);

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


const git = createGitService(defaultCommandRunner, CWD);
const connector = DRY_RUN ? createDryRunConnector() : createSocketConnector();
const cmux = createCmuxService(connector);
const github = createGitHubService(defaultCommandRunner, CWD);

// globalThis cache for bun --hot state persistence
const g = globalThis as Record<string, unknown>;

// Stop old watcher before creating new one (bun --hot cleanup)
if (g.__cmuxHubWatcher) {
  (g.__cmuxHubWatcher as ReturnType<typeof createFileWatcher>).stop();
  logger.debug("stopped previous watcher for hot reload");
}
const watcher = createFileWatcher(defaultWatcherFactory, CWD);
g.__cmuxHubWatcher = watcher;

// Load launch.json if present.
// Use globalThis cache for bun --hot; launcher implements AsyncDisposable
// so cleanup() is called via Symbol.asyncDispose on normal exit.
let launcher: Launcher | undefined;
if (g.__cmuxHubLauncher) {
  launcher = g.__cmuxHubLauncher as Launcher;
  logger.debug("reusing existing launcher from globalThis");
} else {
  try {
    const launchJson = await loadLaunchJson(CWD);
    if (launchJson) {
      logger.info("Found launch.json with", launchJson.configurations.length, "configurations");
      launcher = createLauncher({
        cwd: CWD,
        launchJson,
        onChange: () => {},
      });
      g.__cmuxHubLauncher = launcher;
    }
  } catch (e) {
    logger.info("Failed to load launch.json:", e instanceof Error ? e.message : e);
  }
}

// Helper to open a cmux browser split for preview
async function openPreviewSplit(url: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([CMUX_BIN, "--json", "browser", "open-split", url], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const json = JSON.parse(output) as { surface_ref?: string };
    return json.surface_ref ?? null;
  } catch {
    return null;
  }
}

// Helper to eval JS in a cmux browser surface
async function browserEval(surfaceRef: string, script: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([CMUX_BIN, "browser", surfaceRef, "eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output;
  } catch {
    return null;
  }
}

// Detect dev mode: compiled binary sets Bun.main differently
const isDev = !process.execPath.includes("cmux-hub");
const devOutDir = path.join(import.meta.dir, "..", ".dev-dist");

const appDeps: Parameters<typeof createAppConfig>[0] = {
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
  reviewDirs: REVIEW_DIRS,
  launcher,
  openPreviewSplit,
  browserEval,
  development: isDev,
  devDistDir: isDev ? devOutDir : undefined,
};
// Stop old app's timers/watchers before creating new one (bun --hot cleanup)
if (g.__cmuxHubApp) {
  (g.__cmuxHubApp as ReturnType<typeof createAppConfig>).stop();
  logger.debug("stopped previous app for hot reload");
}
const app = createAppConfig(appDeps);
g.__cmuxHubApp = app;

// Wire up launcher onChange to broadcast via WebSocket
if (launcher) {
  launcher.setOnChange((states) => {
    app.broadcastLauncherUpdate(states);
  });
}

// Dev mode: build frontend with Bun.build() instead of relying on Bun's HTML bundler cache

async function devBuild(): Promise<boolean> {
  const plugin = (await import("bun-plugin-tailwind")).default;
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "index.html")],
    outdir: devOutDir,
    plugins: [plugin],
    target: "browser",
    sourcemap: "linked",
  });
  if (!result.success) {
    logger.info("Dev build failed:", result.logs);
  }
  return result.success;
}

if (isDev) {
  await devBuild();
  logger.info("Dev build complete");
}

// In production, Bun's HTML import serves "/"; in dev, app.fetch serves from devDistDir
const routes = isDev
  ? app.apiRoutes
  : { ...app.apiRoutes, "/": index };

const server = serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: routes as Parameters<typeof serve>[0]["routes"],
  websocket: app.websocket,
  fetch: app.fetch,
});

app.setServer(server);
app.startWatcher();

// Dev mode: watch src/ files and rebuild frontend on changes
if (isDev) {
  const { watch } = await import("node:fs");
  let devBuildTimer: ReturnType<typeof setTimeout> | null = null;
  const srcDir = path.join(import.meta.dir);
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith(".dev-dist")) return;
    if (devBuildTimer) clearTimeout(devBuildTimer);
    devBuildTimer = setTimeout(async () => {
      logger.debug("dev: rebuilding frontend...");
      const ok = await devBuild();
      if (ok) {
        logger.debug("dev: rebuild complete, sending reload");
        app.broadcast(JSON.stringify({ type: "dev-reload" }));
      }
    }, 300);
  });
}

// Cleanup on termination signals (e.g. SIGHUP from parent shell exit)
async function cleanup() {
  logger.info("cmux-hub: shutting down...");
  // AsyncDisposable — single path for all shutdown scenarios
  await launcher?.[Symbol.asyncDispose]();
  watcher.stop();
  server.stop();
  // Remove auto-created review directories so orphan files from a previous
  // run don't leak into the next session. User-specified --review-dir paths
  // are preserved (they may be long-lived project dirs).
  if (REVIEW_DIR_OVERRIDES.length === 0) {
    for (const dir of REVIEW_DIRS) {
      removeDirSafe(dir);
    }
  }
  process.exit(0);
}
// Remove old signal handlers before adding new ones (bun --hot cleanup)
if (g.__cmuxHubCleanup) {
  const old = g.__cmuxHubCleanup as () => Promise<void>;
  process.off("SIGHUP", old);
  process.off("SIGINT", old);
  process.off("SIGTERM", old);
}
g.__cmuxHubCleanup = cleanup;
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

    const json = JSON.parse(output) as { surface_ref?: string };
    return json.surface_ref ?? null;
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
  await cleanup();
}

// Dev mode: skip browser split, just log the URL
if (isDev) {
  logger.info("Dev mode: open http://127.0.0.1:" + server.port);
} else {
  // bun --hot re-executes top-level code on every change.
  // Store the browser surface ref in globalThis to avoid opening a new window each time.
  const existingSurface = (globalThis as Record<string, unknown>).__cmuxHubBrowserSurface as
    | string
    | undefined;
  if (existingSurface) {
    logger.debug("reusing existing browser surface:", existingSurface);
    appDeps.browserSurfaceId = existingSurface;
    waitForBrowserClose(existingSurface);
  } else {
    const browserSurface = await openBrowserSplit();
    if (browserSurface) {
      (globalThis as Record<string, unknown>).__cmuxHubBrowserSurface = browserSurface;
      appDeps.browserSurfaceId = browserSurface;
      waitForBrowserClose(browserSurface);
    } else {
      logger.info("cmux browser split not available, open http://127.0.0.1:" + server.port);
    }
  }
}
