import { test, expect, describe } from "bun:test";
import assert from "node:assert/strict";
import { validateLaunchJson, loadLaunchJson, createLauncher } from "../launcher.ts";
import type { LaunchJson } from "../launcher.ts";
import { join } from "node:path";

describe("validateLaunchJson", () => {
  test("valid launch.json", () => {
    const data = {
      version: "0.0.1",
      configurations: [
        {
          name: "my-app",
          runtimeExecutable: "bun",
          runtimeArgs: ["run", "dev"],
          port: 3000,
        },
      ],
    };
    const result = validateLaunchJson(data);
    expect(result.version).toBe("0.0.1");
    expect(result.configurations).toHaveLength(1);
    const first = result.configurations[0];
    assert(first);
    expect(first.name).toBe("my-app");
  });

  test("valid launch.json with program instead of runtimeExecutable", () => {
    const data = {
      version: "0.0.1",
      configurations: [
        {
          name: "server",
          program: "server.js",
          port: 8080,
        },
      ],
    };
    const result = validateLaunchJson(data);
    const first = result.configurations[0];
    assert(first);
    expect(first.program).toBe("server.js");
  });

  test("valid launch.json with multiple configurations", () => {
    const data = {
      version: "0.0.1",
      configurations: [
        { name: "frontend", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3000 },
        { name: "backend", runtimeExecutable: "bun", runtimeArgs: ["run", "server.ts"], port: 8080 },
      ],
    };
    const result = validateLaunchJson(data);
    expect(result.configurations).toHaveLength(2);
  });

  test("defaults version when missing", () => {
    const data = {
      configurations: [
        { name: "app", runtimeExecutable: "bun", port: 3000 },
      ],
    };
    const result = validateLaunchJson(data);
    expect(result.version).toBe("0.0.1");
  });

  test("rejects non-object", () => {
    expect(() => validateLaunchJson("string")).toThrow("must be an object");
    expect(() => validateLaunchJson(null)).toThrow("must be an object");
    expect(() => validateLaunchJson(42)).toThrow("must be an object");
  });

  test("rejects missing configurations", () => {
    expect(() => validateLaunchJson({ version: "0.0.1" })).toThrow("configurations array");
  });

  test("rejects configuration without name", () => {
    expect(() =>
      validateLaunchJson({
        configurations: [{ runtimeExecutable: "bun", port: 3000 }],
      }),
    ).toThrow("must have a name");
  });

  test("rejects configuration without port", () => {
    expect(() =>
      validateLaunchJson({
        configurations: [{ name: "app", runtimeExecutable: "bun" }],
      }),
    ).toThrow("must have a port number");
  });

  test("rejects configuration without runtimeExecutable or program", () => {
    expect(() =>
      validateLaunchJson({
        configurations: [{ name: "app", port: 3000 }],
      }),
    ).toThrow("must have runtimeExecutable or program");
  });
});

describe("loadLaunchJson", () => {
  test("returns null when file does not exist", async () => {
    const result = await loadLaunchJson("/tmp/nonexistent-dir-" + Date.now());
    expect(result).toBeNull();
  });

  test("loads launch.json from .claude directory", async () => {
    const tmpDir = `/tmp/cmux-hub-test-${Date.now()}`;
    const claudeDir = join(tmpDir, ".claude");
    await Bun.write(
      join(claudeDir, "launch.json"),
      JSON.stringify({
        version: "0.0.1",
        configurations: [
          { name: "test-app", runtimeExecutable: "echo", runtimeArgs: ["hello"], port: 9999 },
        ],
      }),
    );
    const result = await loadLaunchJson(tmpDir);
    assert(result);
    const first = result.configurations[0];
    assert(first);
    expect(first.name).toBe("test-app");
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true });
  });
});

describe("createLauncher", () => {
  function randomPort() {
    return 30000 + Math.floor(Math.random() * 10000);
  }

  function makeLaunchJson(port: number): LaunchJson {
    return {
      version: "0.0.1",
      configurations: [
        {
          name: "echo-server",
          runtimeExecutable: "bun",
          runtimeArgs: ["-e", `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') })`],
          port,
        },
      ],
    };
  }

  test("getStates returns initial stopped state", () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });
    const states = launcher.getStates();
    expect(states).toHaveLength(1);
    const first = states[0];
    assert(first);
    expect(first.name).toBe("echo-server");
    expect(first.status).toBe("stopped");
    launcher.cleanup();
  });

  test("start transitions to running", async () => {
    const port = randomPort();
    const changes: string[] = [];
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: (states) => {
        const first = states[0];
        assert(first);
        changes.push(first.status);
      },
    });

    await launcher.start("echo-server");
    const states = launcher.getStates();
    const first = states[0];
    assert(first);
    expect(first.status).toBe("running");
    expect(first.port).toBe(port);
    expect(changes).toContain("starting");
    expect(changes).toContain("running");

    launcher.cleanup();
  });

  test("stop transitions to stopped", async () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });

    await launcher.start("echo-server");
    const running = launcher.getStates()[0];
    assert(running);
    expect(running.status).toBe("running");

    await launcher.stop("echo-server");
    const stopped = launcher.getStates()[0];
    assert(stopped);
    expect(stopped.status).toBe("stopped");

    launcher.cleanup();
  });

  test("restart cycles through states", async () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });

    await launcher.start("echo-server");
    const before = launcher.getStates()[0];
    assert(before);
    expect(before.status).toBe("running");

    await launcher.restart("echo-server");
    const after = launcher.getStates()[0];
    assert(after);
    expect(after.status).toBe("running");
    expect(after.port).toBe(port);

    launcher.cleanup();
  });

  test("setSurfaceRef updates state", () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });
    launcher.setSurfaceRef("echo-server", "surface:42");
    const state = launcher.getStates()[0];
    assert(state);
    expect(state.surfaceRef).toBe("surface:42");
    launcher.cleanup();
  });

  test("cleanup kills all processes", async () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });
    await launcher.start("echo-server");

    launcher.cleanup();
    const state = launcher.getStates()[0];
    assert(state);
    expect(state.status).toBe("stopped");

    // Port should be freed after cleanup
    await Bun.sleep(200);
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    expect(server.port).toBe(port);
    server.stop();
  });

  test("start with unknown name throws", async () => {
    const port = randomPort();
    const launcher = createLauncher({
      cwd: "/tmp",
      launchJson: makeLaunchJson(port),
      onChange: () => {},
    });
    expect(launcher.start("nonexistent")).rejects.toThrow("not found");
    launcher.cleanup();
  });
});

describe("generateInspectorScript", () => {
  test("generates script with correct API base URL", async () => {
    const { generateInspectorScript } = await import("../inspector.ts");
    const script = generateInspectorScript(4567);
    expect(script).toContain("http://127.0.0.1:4567");
    expect(script).toContain("__cmuxHubInspector");
    expect(script).toContain("/api/preview-comment");
  });
});
