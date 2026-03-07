import { connect, type Socket } from "node:net";

const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";

export type SocketConnector = (path: string) => Promise<CmuxConnection>;

type CmuxConnection = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

export function createSocketConnector(): SocketConnector {
  return async (path: string) => {
    return new Promise<CmuxConnection>((resolve, reject) => {
      const socket: Socket = connect(path, () => {
        resolve(createConnection(socket));
      });
      socket.on("error", reject);
    });
  };
}

/**
 * Dry-run connector that logs messages instead of sending to cmux socket.
 * Use for local development without cmux.
 */
export function createDryRunConnector(): SocketConnector {
  return async (_path: string) => ({
    async send(method, params = {}) {
      console.log(`[cmux dry-run] ${method}`, JSON.stringify(params));
      return { ok: true };
    },
    close() {},
  });
}

function createConnection(socket: Socket): CmuxConnection {
  let requestId = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        const handler = pending.get(response.id);
        if (handler) {
          pending.delete(response.id);
          if (response.error) {
            handler.reject(new Error(response.error.message ?? JSON.stringify(response.error)));
          } else {
            handler.resolve(response.result);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  });

  return {
    send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = `req-${++requestId}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const message = JSON.stringify({ id, method, params }) + "\n";
        socket.write(message);

        // Timeout after 5 seconds
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Request ${id} timed out`));
          }
        }, 5000);
      });
    },
    close() {
      socket.destroy();
      for (const [, handler] of pending) {
        handler.reject(new Error("Connection closed"));
      }
      pending.clear();
    },
  };
}

export type CmuxService = ReturnType<typeof createCmuxService>;

export function createCmuxService(connector: SocketConnector, socketPath = DEFAULT_SOCKET_PATH) {
  async function withConnection<T>(fn: (conn: CmuxConnection) => Promise<T>): Promise<T> {
    const conn = await connector(socketPath);
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  }

  return {
    async sendText(text: string, surfaceId?: string): Promise<void> {
      await withConnection(async (conn) => {
        const params: Record<string, unknown> = { text };
        if (surfaceId) {
          params.surface_id = surfaceId;
        }
        await conn.send("surface.send_text", params);
      });
    },

    async listSurfaces(): Promise<unknown> {
      return withConnection(async (conn) => {
        return conn.send("surface.list");
      });
    },

    async notify(title: string, body: string, subtitle?: string): Promise<void> {
      await withConnection(async (conn) => {
        const params: Record<string, unknown> = { title, body };
        if (subtitle) params.subtitle = subtitle;
        await conn.send("notification.create", params);
      });
    },

    async getSidebarState(): Promise<unknown> {
      return withConnection(async (conn) => {
        return conn.send("sidebar.state");
      });
    },

    /**
     * Format a review comment and send it to the terminal
     */
    async sendComment(
      file: string,
      startLine: number,
      endLine: number,
      comment: string,
      surfaceId?: string,
    ): Promise<void> {
      const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
      const text = `${file}:${range}\n${comment}\n`;
      await this.sendText(text, surfaceId);
    },

    /**
     * Send a command to the terminal (e.g., git commit, gh pr create)
     */
    async sendCommand(command: string, surfaceId?: string): Promise<void> {
      // `!` prefix triggers shell mode in cmux — must be typed separately before pasting the rest
      if (command.startsWith("!")) {
        await this.sendText("!", surfaceId);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await this.sendText(command.slice(1) + "\n", surfaceId);
      } else {
        await this.sendText(command + "\n", surfaceId);
      }
    },
  };
}
