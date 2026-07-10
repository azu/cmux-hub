#!/usr/bin/env bun
/**
 * Hub mode entry point — one persistent server for all projects.
 *
 * Sessions register their project directory over HTTP (harness-agnostic):
 *
 *   curl -s -X POST http://127.0.0.1:4700/api/projects/register \
 *     -H 'Content-Type: application/json' \
 *     -d "{\"cwd\": \"$PWD\", \"surfaceId\": \"$CMUX_SURFACE_ID\"}"
 *
 * and unregister on session end. The UI lists registered projects and shows
 * each one's diff. Unlike the per-session CLI, this server never opens a
 * cmux browser split and never auto-shuts down.
 */
import { serve } from "bun";
import { parseArgs } from "node:util";
import path from "node:path";
import index from "./index.html";
import { defaultCommandRunner } from "../server/git.ts";
import { createCmuxService, createSocketConnector, createDryRunConnector } from "../server/cmux.ts";
import { defaultWatcherFactory } from "../server/watcher.ts";
import { createAppConfig } from "../server/app.ts";
import { logger, enableDebug } from "../server/logger.ts";
import { loadActions } from "../server/actions.ts";
import type { MenuItem } from "../server/actions.ts";
import { createProjectRegistry, defaultPersistPath } from "../server/projects.ts";
import type { ProjectRegistry } from "../server/projects.ts";
import { resolveDefaultReviewDir, resolveReviewDirs } from "../server/review.ts";
import pkg from "../package.json" with { type: "json" };

const DEFAULT_HUB_PORT = "4700";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "hub"),
  options: {
    port: { type: "string", short: "p", default: process.env.PORT ?? DEFAULT_HUB_PORT },
    "dry-run": { type: "boolean", default: process.env.CMUX_HUB_DRY_RUN === "true" },
    "projects-file": { type: "string" },
    "allow-project-shell-actions": { type: "boolean", default: false },
    actions: { type: "string", short: "a" },
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

if (values.help) {
  console.log(`cmux-hub (hub mode) - persistent multi-project diff viewer

Usage: bun src/hub-main.ts [options]

Options:
  -p, --port <port>      Server port (default: ${DEFAULT_HUB_PORT})
  -a, --actions <file>   Hub-level fallback toolbar actions JSON (use - for stdin).
                         A project-local .claude/cmux-hub.json or
                         .cmux-hub/actions.json takes priority.
  --dry-run              Don't connect to cmux socket
  --debug                Enable debug logging
  -v, --version          Show version
  -h, --help             Show this help

Session registration (add to your harness's session start/end hooks):
  register:   curl -s -X POST http://127.0.0.1:${DEFAULT_HUB_PORT}/api/projects/register \\
                -H 'Content-Type: application/json' \\
                -d "{\\"cwd\\": \\"$PWD\\", \\"surfaceId\\": \\"$CMUX_SURFACE_ID\\"}"
  unregister: curl -s -X POST http://127.0.0.1:${DEFAULT_HUB_PORT}/api/projects/unregister \\
                -H 'Content-Type: application/json' -d "{\\"cwd\\": \\"$PWD\\"}"`);
  process.exit(0);
}

if (values.debug) {
  enableDebug();
}

const PORT = parseInt(values.port ?? DEFAULT_HUB_PORT, 10);
const PROJECTS_FILE = values["projects-file"] ?? defaultPersistPath();
const DRY_RUN = values["dry-run"] ?? false;

// globalThis cache for bun --hot state persistence
const g = globalThis as Record<string, unknown>;

// Hub-level fallback actions (project-local config takes priority)
let hubActions: MenuItem[] | undefined;
if (values.actions) {
  if (g.__cmuxHubActions) {
    hubActions = g.__cmuxHubActions as MenuItem[];
  } else {
    try {
      hubActions = await loadActions(values.actions);
      g.__cmuxHubActions = hubActions;
    } catch (e) {
      console.error("Failed to load actions:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }
}

const connector = DRY_RUN ? createDryRunConnector() : createSocketConnector();
const cmux = createCmuxService(connector);

// Review dir: a single stable hub-level directory
const REVIEW_DIRS = resolveReviewDirs([resolveDefaultReviewDir({ overrideId: "hub" })], {
  createIfMissing: true,
});

// Stop previous instances on hot reload
if (g.__cmuxHubRegistry) {
  (g.__cmuxHubRegistry as ProjectRegistry).stop();
}
if (g.__cmuxHubApp) {
  (g.__cmuxHubApp as ReturnType<typeof createAppConfig>).stop();
}

// `app` is assigned below; the registry callbacks only fire on later events
let app: ReturnType<typeof createAppConfig> | undefined;
const registry = createProjectRegistry({
  runner: defaultCommandRunner,
  watcherFactory: defaultWatcherFactory,
  hubActions,
  persistPath: PROJECTS_FILE,
  allowProjectShellActions: values["allow-project-shell-actions"] ?? false,
  onDiffChanged: (projectId, event) => app?.broadcastDiffUpdated(projectId, event),
  onProjectsChanged: () => app?.broadcastProjectsUpdated(),
});
g.__cmuxHubRegistry = registry;
await registry.load();
registry.startPruning();

// Detect dev mode: compiled binary sets Bun.main differently
const isDev = !process.execPath.includes("cmux-hub");
const devOutDir = path.join(import.meta.dir, "..", ".dev-dist");

app = createAppConfig({
  port: PORT,
  cmux,
  registry,
  actions: hubActions,
  reviewDirs: REVIEW_DIRS,
  development: isDev,
  devDistDir: isDev ? devOutDir : undefined,
});
g.__cmuxHubApp = app;

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

const routes = isDev ? app.apiRoutes : { ...app.apiRoutes, "/": index };

const server = serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: routes as Parameters<typeof serve>[0]["routes"],
  websocket: app.websocket,
  fetch: app.fetch,
});

app.setServer(server);
app.startWatcher();

// Dev mode: watch src/ files and rebuild frontend on changes.
// Close the previous watcher on bun --hot reload so builds don't stack up.
if (isDev) {
  const { watch } = await import("node:fs");
  if (g.__cmuxHubDevWatcher) {
    (g.__cmuxHubDevWatcher as { close: () => void }).close();
  }
  let devBuildTimer: ReturnType<typeof setTimeout> | null = null;
  const devWatcher = watch(import.meta.dir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith(".dev-dist")) return;
    if (devBuildTimer) clearTimeout(devBuildTimer);
    devBuildTimer = setTimeout(async () => {
      const ok = await devBuild();
      if (ok) {
        app?.broadcast(JSON.stringify({ type: "dev-reload" }));
      }
    }, 300);
  });
  g.__cmuxHubDevWatcher = devWatcher;
}

async function cleanup() {
  logger.info("cmux-hub: shutting down...");
  registry.stop();
  app?.stop();
  server.stop();
  process.exit(0);
}
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

logger.info(`cmux-hub (hub mode) running at http://127.0.0.1:${server.port}`);
logger.info(`Projects file: ${PROJECTS_FILE}`);
