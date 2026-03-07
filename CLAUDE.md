
# cmux-hub

Diff viewer for cmux. React frontend + Bun server, communicating with cmux via Unix domain socket.

## Runtime

Default to using Bun instead of Node.js.

- `bun test src server` to run tests (scoped to avoid Playwright conflicts)
- `bun --hot src/cli.ts` for development with hot reload
- `bun run build:compile` to build standalone binary
- Pre-commit hook runs secretlint. Use generic paths (e.g. `/home/user/project`) in tests and docs to avoid homedir detection errors.

## Architecture

- `src/cli.ts` — CLI entry point (binary). Resolves target dir, terminal surface, loads actions, starts server, opens cmux browser split
- `src/index.ts` — Dev entry point (simpler, no cmux integration)
- `server/app.ts` — API routes and WebSocket handling
- `server/actions.ts` — Action type definitions, validation, shell escaping
- `src/components/` — React components (Toolbar, DiffView, DiffFile, DiffLine)

## Actions

Toolbar actions are defined externally via `--actions <file|->` JSON. Type is required.

```ts
type ActionItem = {
  label: string;
  command: string;
  type: "paste-and-enter" | "shell" | "paste";
  input?: { placeholder: string; variable: string; };
};
```

- `paste-and-enter`: paste to cmux terminal with Enter
- `shell`: execute as subshell on server, returns stdout/stderr/exitCode
- `paste`: paste to cmux terminal without Enter

User variables use env prefix method (`KEY='escaped' command`). Built-in vars (`CMUX_HUB_*`) are only added for `shell` type.

## Security

Localhost-only server (`127.0.0.1`). Key defenses against browser-based attacks (malicious page → localhost):

- Host header validation (DNS rebinding)
- Origin header validation (CORS/CSRF)
- Sec-Fetch-Site check on write operations
- Null Origin rejected on POST from browsers
- `/api/action` accepts action ID + variables only, not raw commands
- Variable keys validated against `[A-Za-z_][A-Za-z0-9_]*`
- File path access restricted to repository cwd

## HMR

`bun --hot` re-executes top-level code. Use `globalThis` to persist state across reloads (e.g. browser surface ref to avoid opening duplicate windows).

## File Watcher

Watches both working tree files and git ref changes (commits, branch switches). For git worktrees, resolves and watches the actual git dir separately via `git rev-parse --git-dir`.
