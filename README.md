# cmux-hub

A browser-based diff viewer for [cmux](https://cmux.dev). See what changed at a glance — syntax-highlighted diffs, inline review comments, commit history, GitHub PR status, and custom toolbar actions, all streamed in real time via WebSocket.

> **Fork note (`local-hub` branch):** this fork adds a persistent, harness-agnostic
> **hub mode** — one local server that lists all projects with active agent
> sessions and shows each one's diff. See [Hub mode](#hub-mode-local-fork) below.
> `main` tracks the original upstream project.

## Hub mode (local fork)

Hub mode runs one long-lived server (default port `4700`) instead of one server
per session. Sessions from **any** harness (Claude Code, or anything that can
run a curl command) register themselves, and the browser UI shows a live
project list; clicking a project opens its diff.

```bash
bun install
bun run hub            # start the hub at http://127.0.0.1:4700
bun run dev:hub        # same, with hot reload for development
```

### What's different from upstream

- **Project list** at `/` — projects appear when a session registers, are
  marked _inactive_ when it ends (they linger for 24h or until dismissed with ✕),
  and persist across hub restarts (`~/.config/cmux-hub/projects.json`).
- **Line counts** — total `+/−` added/deleted lines per diff and per file.
- **Word-level diff emphasis** — the exact words that changed get a darker
  tint, GitHub-style.
- **PR link** — when the current branch has a PR, a state chip linking to it
  shows in the toolbar and in the project list.
- **Default actions** are `Commit & Push` and `Create PR`, delivered to the
  agent session as prompts (custom actions still come from
  `.claude/cmux-hub.json` or `.cmux-hub/actions.json` in the project, falling
  back to `--actions <file>` passed to the hub).
- **Clipboard fallback** — inline comments and toolbar actions paste into the
  cmux terminal when the session registered one; otherwise the text is copied
  to your clipboard (with a toast) so you can paste it into whatever session
  is active.

### Registering sessions

The hub learns about "active sessions" via a tiny HTTP API — no plugin needed:

| Endpoint                        | Body                                           | Effect                          |
| ------------------------------- | ---------------------------------------------- | ------------------------------- |
| `POST /api/projects/register`   | `{ "cwd", "name?", "harness?", "surfaceId?" }` | Add/activate a project          |
| `POST /api/projects/unregister` | `{ "cwd" }` or `{ "id" }`                      | Mark inactive (lingers in list) |
| `POST /api/projects/heartbeat`  | `{ "cwd" }` or `{ "id" }`                      | Refresh `lastSeenAt`            |
| `POST /api/projects/dismiss`    | `{ "id" }`                                     | Remove from the list            |

**Claude Code** — add to `~/.claude/settings.json` (or a project's
`.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST http://127.0.0.1:4700/api/projects/register -H 'Content-Type: application/json' -d \"{\\\"cwd\\\": \\\"$PWD\\\", \\\"harness\\\": \\\"claude-code\\\", \\\"surfaceId\\\": \\\"$CMUX_SURFACE_ID\\\"}\" || true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST http://127.0.0.1:4700/api/projects/unregister -H 'Content-Type: application/json' -d \"{\\\"cwd\\\": \\\"$PWD\\\"}\" || true"
          }
        ]
      }
    ]
  }
}
```

`surfaceId` is optional — set it only when the session runs inside cmux so
comments/actions can be pasted straight into that terminal. Any other harness
just needs to run the same two curl commands at session start/end (that's the
point: manual per-harness setup, no plugin coupling).

Lifecycle notes:

- If a session dies without unregistering, its project is demoted to
  _inactive_ after 24h without a register/heartbeat signal (watchers and PR
  polling stop). Long-lived sessions can `POST /api/projects/heartbeat`
  periodically to stay active.
- Inactive projects are pruned 24h after they became inactive, or immediately
  via ✕ in the UI.

Security model (hub mode):

- Registration endpoints (`register`/`unregister`/`heartbeat`) only accept
  non-browser clients — requests carrying `Origin`/`Sec-Fetch-Site` headers
  are rejected, so a malicious localhost web page cannot register arbitrary
  repos to read their diffs.
- Hub mode restricts allowed origins to the hub's own origin (single-project
  mode keeps the any-localhost-port allowance needed for preview pages).
- `type: "shell"` actions in a repo's own `.claude/cmux-hub.json` /
  `.cmux-hub/actions.json` are **ignored** (they would execute on the server
  from repo-controlled files). Start the hub with
  `--allow-project-shell-actions` if you want them, or define shell actions in
  the hub-level `--actions` file, which is always trusted.
- Register only repos you actually work in: running git in a repo executes
  repo-controlled config like `core.fsmonitor` — the same exposure your shell
  and agent already have in that directory, but worth knowing.

To keep the hub running permanently on macOS, either leave `bun run hub` in a
terminal or wrap it in a `launchd` agent.

https://github.com/user-attachments/assets/f5fbfd8b-6473-4f83-882e-967a5ca33205

![cmux-hub with cmux](docs/img/cmux-hub-overview.png)

## Screenshots

### Diff View

Syntax-highlighted diff with add/delete coloring and line numbers.

![Diff View](docs/img/diff-view.png)

### Inline Review Comments

Select lines and write review comments that are sent to the cmux terminal.

![Review Comment](docs/img/review-comment.png)

### Commit History

Browse recent commits when no pending changes are detected.

![Commit List](docs/img/commit-list.png)

### Toolbar

Branch name, navigation links, and custom action buttons.

![Toolbar](docs/img/toolbar.png)

Update screenshots: `bun run screenshots`

## Features

- Diff view with syntax highlighting (Shiki)
- Real-time diff updates via WebSocket
- Untracked and unstaged file detection
- Commit history browser (when no pending changes)
- Plan file viewer (Claude Code session plans with syntax highlighting)
- Branch selector for switching diff base
- Hash-based URL routing with browser back/forward support
- Custom toolbar actions via JSON (with submenu support)
- File watcher with auto-refresh (working tree + git ref changes)
- Inline review comments sent to cmux terminal
- GitHub PR integration (CI status, PR review comments)
- WebSocket real-time updates (diff changes, PR/CI polling)
- Self-update command (`cmux-hub update`)
- Auto-shutdown when browser tab closes
- Git worktree support

## Prerequisites

cmux-hub connects to the cmux Unix socket (`/tmp/cmux.sock`). The default socket mode only allows cmux child processes to connect.

If you launch cmux-hub from within cmux (e.g. Claude Code commands, terminal shell), the default mode works. If you launch from an external process (Alfred, Raycast, Karabiner Elements, etc.), set **Automation mode**:

> cmux Settings → Automation → Socket Control Mode → **Automation mode**

Or set `CMUX_SOCKET_MODE=allowAll`.

## Install

Download binary from [GitHub Releases](https://github.com/azu/cmux-hub/releases/latest):

```bash
mkdir -p ~/.local/bin
curl -fsSL "https://github.com/azu/cmux-hub/releases/latest/download/cmux-hub-darwin-arm64" -o ~/.local/bin/cmux-hub
chmod +x ~/.local/bin/cmux-hub
```

## Update

```bash
cmux-hub update
```

## Usage

```bash
# Run (diff of current directory)
cmux-hub

# Specify target directory
cmux-hub /home/user/project

# Custom toolbar actions
cmux-hub --actions actions.json

# Read actions from stdin
cat actions.json | cmux-hub --actions -
```

### Usage with cmux + Claude Code

When launched inside cmux, cmux-hub automatically opens a browser split pane and shuts down when the pane closes.

#### Plugin (recommended)

Install as a Claude Code plugin. This auto-installs the binary, sets up SessionStart hooks, and copies default actions to `~/.claude/cmux-hub.json`. Project-local `.claude/cmux-hub.json` takes priority if present.

```bash
claude plugin marketplace add azu/cmux-hub
claude plugin install cmux-hub@cmux-hub-marketplace
```

The first session start downloads the binary, so it may take a few seconds to launch.

Update the plugin:

```bash
claude plugin update cmux-hub@cmux-hub-marketplace
```

#### Manual setup

`.claude/cmux-hub.json`:

```json
[
  { "label": "Commit", "type": "paste-and-enter", "command": "commit this change" },
  { "label": "Create PR", "type": "paste-and-enter", "command": "create a pull request" }
]
```

`.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cmux-hub --actions .claude/cmux-hub.json"
          }
        ]
      }
    ]
  }
}
```

### Options

```
-p, --port <port>      Server port (default: random)
-a, --actions <file>   Toolbar actions JSON file (use - for stdin)
--dry-run              Don't connect to cmux socket
--debug                Enable debug logging (also: DEBUG=*)
-v, --version          Show version
-h, --help             Show help
```

## Diff Behavior

### Auto-diff

The `/api/diff/auto` endpoint computes the appropriate diff range based on the current branch.

| Situation                    | Diff range                        | Includes untracked |
| ---------------------------- | --------------------------------- | ------------------ |
| Feature branch               | merge-base to HEAD + working tree | No                 |
| Default branch (main/master) | HEAD vs working tree              | Yes                |
| No commits yet               | Staged changes                    | Yes                |

### Commit History

When no pending changes are detected, the UI shows recent commits. Clicking a commit displays its diff. A "Commits" link in the toolbar opens the commit list at any time.

## Custom Actions

Pass a JSON file via `--actions` to customize toolbar buttons. The `type` field is required.

### Action Definition

```json
[
  {
    "label": "Commit",
    "type": "paste-and-enter",
    "command": "/commit"
  },
  {
    "label": "Create PR",
    "type": "shell",
    "command": "gh pr create --title \"$TITLE\"",
    "input": { "placeholder": "PR title...", "variable": "TITLE" }
  },
  {
    "label": "More",
    "submenu": [{ "label": "Stash", "type": "shell", "command": "git stash" }]
  }
]
```

### Action Fields

| Field     | Type                                      | Description                          |
| --------- | ----------------------------------------- | ------------------------------------ |
| `label`   | `string`                                  | Button label                         |
| `command` | `string`                                  | Command to execute                   |
| `type`    | `"paste-and-enter" \| "shell" \| "paste"` | Execution mode (required)            |
| `input`   | `{ placeholder, variable }`               | Shows an input form before executing |
| `submenu` | `ActionItem[]`                            | Nested menu (instead of `command`)   |

### Execution Modes

| type                | Behavior                                                             | Use case                                             |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `"shell"`           | Executes as a subshell on the server. Returns stdout/stderr/exitCode | `git commit`, `gh pr create`                         |
| `"paste-and-enter"` | Pastes text to cmux terminal and sends Enter                         | Commands for Claude Code or other terminal processes |
| `"paste"`           | Pastes text to cmux terminal without Enter                           | Paste text only                                      |

### Variables

Commands can reference shell variables. Variables are prepended as inline environment variables (env prefix).

#### Built-in Variables (shell type only)

| Variable               | Description                      | Example              |
| ---------------------- | -------------------------------- | -------------------- |
| `$CMUX_HUB_CWD`        | Target directory (absolute path) | `/home/user/project` |
| `$CMUX_HUB_GIT_BRANCH` | Current git branch               | `feat/new-feature`   |
| `$CMUX_HUB_GIT_BASE`   | Diff base branch (auto-detected) | `main`               |
| `$CMUX_HUB_PORT`       | Server port                      | `4567`               |
| `$CMUX_HUB_SURFACE_ID` | cmux terminal surface ID         | `surface:123`        |

#### User Input Variables

Variables defined in `input.variable` are set as environment variables from user input.

```json
{ "command": "git commit -m \"$MSG\"", "input": { "variable": "MSG" } }
```

#### Safety

Variable values are single-quote escaped and prepended as env prefix. The `/api/action` endpoint only accepts an action ID and user input variables — not raw command strings. Variable keys are validated against `[A-Za-z_][A-Za-z0-9_]*`.

## GitHub Integration

When the current branch has an associated Pull Request, cmux-hub polls GitHub via `gh` CLI and displays:

- CI check statuses (success, failure, in-progress)
- PR review comments with file path and line number
- PR info (title, state, base/head branch)

PR data is pushed to the frontend via WebSocket every 10 seconds.

## API Endpoints

| Method | Path                                | Description                                   |
| ------ | ----------------------------------- | --------------------------------------------- |
| GET    | `/api/diff`                         | Diff with optional `base` and `target` params |
| GET    | `/api/diff/auto`                    | Auto-computed diff based on branch context    |
| GET    | `/api/diff/files`                   | List of changed files                         |
| GET    | `/api/diff/commit?hash=`            | Diff for a specific commit                    |
| GET    | `/api/file-lines?path=&start=&end=` | Read file lines                               |
| GET    | `/api/log?count=`                   | Recent commit log                             |
| GET    | `/api/branches`                     | List branches and current branch              |
| GET    | `/api/status`                       | Server status, branch, cwd, actions           |
| GET    | `/api/plan`                         | Current session's plan file (markdown)        |
| GET    | `/api/pr`                           | Current PR info                               |
| GET    | `/api/pr/comments`                  | PR review comments                            |
| GET    | `/api/ci`                           | CI check statuses                             |
| POST   | `/api/send-to-terminal`             | Send text to cmux terminal                    |
| POST   | `/api/comment`                      | Send inline comment to cmux terminal          |
| POST   | `/api/command`                      | Send command to cmux terminal                 |
| POST   | `/api/action`                       | Execute a toolbar action by ID                |

WebSocket endpoint: `/ws` — receives `diff-updated` and `pr-updated` messages.

## Security

- Localhost-only server (`127.0.0.1`)
- Host header validation (DNS rebinding)
- Origin header validation (CORS/CSRF)
- Sec-Fetch-Site check on write operations
- Null Origin rejected on POST from browsers
- File path access restricted to repository cwd
- Commit hash validated against `/^[0-9a-f]{4,40}$/i`

## Development

```bash
bun install

# HMR with hot reload
bun --hot src/cli.ts

# With custom actions
bun --hot src/cli.ts --actions - <<'EOF'
[
  { "label": "Commit", "type": "paste-and-enter", "command": "commit this change" },
  { "label": "Push", "type": "shell", "command": "git push" }
]
EOF

# Build standalone binary
bun run build:compile
```

```bash
bun test          # Run tests
bun run lint      # Lint
bun run fmt       # Format
bun run typecheck # Type check
bun run test:e2e  # E2E tests
```

## Tech Stack

- Runtime: Bun
- Frontend: React 19 + Tailwind CSS + shadcn/ui
- Syntax Highlighting: Shiki
- cmux communication: Unix domain socket (`/tmp/cmux.sock`) via JSON-RPC
- git: `Bun.spawn` with git CLI
- GitHub: `gh` CLI

## Inspired by

- [Difit](https://difit.dev/)
- [Codex](https://openai.com/codex/)
- [Claude Code on the web](https://claude.ai/)

## License

MIT
