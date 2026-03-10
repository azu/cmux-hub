import { join, resolve } from "node:path";
import { connect } from "node:net";
import { logger } from "./logger.ts";

export type LaunchConfiguration = {
  name: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  program?: string;
  args?: string[];
  port: number;
  cwd?: string;
  env?: Record<string, string>;
  autoPort?: boolean;
};

export type LaunchJson = {
  version: string;
  configurations: LaunchConfiguration[];
};

export type ServerStatus = "stopped" | "starting" | "running" | "error";

export type ServerState = {
  name: string;
  status: ServerStatus;
  port: number;
  configPort: number;
  error?: string;
  surfaceRef?: string;
};

type ManagedServer = {
  config: LaunchConfiguration;
  state: ServerState;
  proc?: ReturnType<typeof Bun.spawn>;
};

export type Launcher = {
  start(name?: string): Promise<void>;
  stop(name?: string): Promise<void>;
  restart(name?: string): Promise<void>;
  getStates(): ServerState[];
  setSurfaceRef(name: string, ref: string): void;
  cleanup(): void;
};

export async function loadLaunchJson(cwd: string): Promise<LaunchJson | null> {
  const filePath = join(cwd, ".claude", "launch.json");
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const data = await file.json();
  return validateLaunchJson(data);
}

export function validateLaunchJson(data: unknown): LaunchJson {
  if (!data || typeof data !== "object") {
    throw new Error("launch.json must be an object");
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.configurations)) {
    throw new Error("launch.json must have a configurations array");
  }
  for (const config of obj.configurations) {
    if (!config || typeof config !== "object") {
      throw new Error("Each configuration must be an object");
    }
    const c = config as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name) {
      throw new Error("Each configuration must have a name");
    }
    if (typeof c.port !== "number") {
      throw new Error(`Configuration "${c.name}" must have a port number`);
    }
    if (!c.runtimeExecutable && !c.program) {
      throw new Error(`Configuration "${c.name}" must have runtimeExecutable or program`);
    }
  }
  return {
    version: typeof obj.version === "string" ? obj.version : "0.0.1",
    configurations: obj.configurations as LaunchConfiguration[],
  };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(false); // port is in use
    });
    socket.on("error", () => {
      resolve(true); // port is available
    });
  });
}

async function waitForPort(port: number, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const available = await isPortAvailable(port);
    if (!available) return true; // something is listening
    await Bun.sleep(500);
  }
  return false;
}

async function findFreePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  const port = server.port;
  server.stop();
  return port;
}

export function createLauncher(opts: {
  cwd: string;
  launchJson: LaunchJson;
  onChange: (states: ServerState[]) => void;
}): Launcher {
  const { cwd, launchJson, onChange } = opts;
  const servers = new Map<string, ManagedServer>();

  // Initialize server states
  for (const config of launchJson.configurations) {
    servers.set(config.name, {
      config,
      state: {
        name: config.name,
        status: "stopped",
        port: config.port,
        configPort: config.port,
      },
    });
  }

  function notifyChange() {
    onChange(Array.from(servers.values()).map((s) => s.state));
  }

  function updateState(name: string, update: Partial<ServerState>) {
    const server = servers.get(name);
    if (!server) return;
    Object.assign(server.state, update);
    notifyChange();
  }

  async function startOne(name: string) {
    const server = servers.get(name);
    if (!server) throw new Error(`Server "${name}" not found`);
    if (server.state.status === "running" || server.state.status === "starting") return;

    const { config } = server;
    let actualPort = config.port;

    // Handle autoPort
    if (config.autoPort) {
      const available = await isPortAvailable(actualPort);
      if (!available) {
        actualPort = await findFreePort();
        logger.info(`Port ${config.port} in use, using ${actualPort} for "${name}"`);
      }
    }

    updateState(name, { status: "starting", port: actualPort, error: undefined });

    // Build command
    const cmd: string[] = [];
    if (config.runtimeExecutable) {
      cmd.push(config.runtimeExecutable, ...(config.runtimeArgs ?? []));
    } else if (config.program) {
      cmd.push("node", config.program, ...(config.args ?? []));
    }

    // Build env
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...config.env,
      PORT: String(actualPort),
    };

    const serverCwd = config.cwd ? resolve(cwd, config.cwd) : cwd;

    logger.info(`Starting "${name}": ${cmd.join(" ")} (port: ${actualPort}, cwd: ${serverCwd})`);

    const proc = Bun.spawn(cmd, {
      cwd: serverCwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    server.proc = proc;

    // Handle unexpected exit
    proc.exited.then((exitCode) => {
      if (server.state.status === "stopped") return; // intentional stop
      logger.info(`"${name}" exited with code ${exitCode}`);
      updateState(name, {
        status: "error",
        error: `Process exited with code ${exitCode}`,
      });
      server.proc = undefined;
    });

    // Wait for port to be ready
    const ready = await waitForPort(actualPort);
    // Re-read status: the proc.exited handler may have changed it
    const currentStatus = server.state.status as ServerStatus;
    if (ready && currentStatus === "starting") {
      logger.info(`"${name}" is running on port ${actualPort}`);
      updateState(name, { status: "running" });
    } else if (currentStatus === "starting") {
      logger.info(`"${name}" failed to start (port ${actualPort} not ready)`);
      updateState(name, {
        status: "error",
        error: `Port ${actualPort} not ready after 60s`,
      });
      proc.kill();
      server.proc = undefined;
    }
  }

  async function stopOne(name: string) {
    const server = servers.get(name);
    if (!server) throw new Error(`Server "${name}" not found`);
    if (!server.proc) {
      updateState(name, { status: "stopped", error: undefined });
      return;
    }

    updateState(name, { status: "stopped" });
    server.proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
    const exited = await Promise.race([
      server.proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited && server.proc) {
      server.proc.kill("SIGKILL");
    }
    server.proc = undefined;
  }

  return {
    async start(name?: string) {
      if (name) {
        await startOne(name);
      } else {
        await Promise.all(Array.from(servers.keys()).map((n) => startOne(n)));
      }
    },

    async stop(name?: string) {
      if (name) {
        await stopOne(name);
      } else {
        await Promise.all(Array.from(servers.keys()).map((n) => stopOne(n)));
      }
    },

    async restart(name?: string) {
      const names = name ? [name] : Array.from(servers.keys());
      for (const n of names) {
        await stopOne(n);
        await startOne(n);
      }
    },

    getStates() {
      return Array.from(servers.values()).map((s) => s.state);
    },

    setSurfaceRef(name: string, ref: string) {
      updateState(name, { surfaceRef: ref });
    },

    cleanup() {
      for (const [, server] of servers) {
        if (server.proc) {
          server.proc.kill("SIGTERM");
          server.proc = undefined;
        }
        server.state.status = "stopped";
      }
    },
  };
}
