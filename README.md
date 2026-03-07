# cmux-hub

Diff viewer for [cmux](https://cmux.dev). Displays branch changes with syntax highlighting, inline comments, commit history browsing, and custom toolbar actions.

## Features

- Diff view with syntax highlighting (Shiki)
- Real-time diff updates via WebSocket
- Untracked and unstaged file detection
- Commit history browser (when no pending changes)
- Branch selector for switching diff base
- Custom toolbar actions via JSON (with submenu support)
- File watcher with auto-refresh (working tree + git ref changes)
- Inline review comments sent to cmux terminal
- GitHub PR integration (CI status, PR review comments)
- WebSocket real-time updates (diff changes, PR/CI polling)
- Auto-shutdown when browser tab closes
- Git worktree support

## Install

```bash
bun install
```

## Usage

### Development

```bash
# HMR with hot reload
bun --hot src/cli.ts

# With custom actions
bun --hot src/cli.ts --actions - <<'EOF'
[
  { "label": "Commit", "type": "paste-and-enter", "command": "/commit" },
  { "label": "Push", "type": "shell", "command": "git push" }
]
EOF
```

### CLI (binary)

```bash
# Build
bun run build:compile

# Run (diff of current directory)
./cmux-hub

# Specify target directory
./cmux-hub /home/user/project

# Custom toolbar actions
./cmux-hub --actions actions.json

# Read actions from stdin
cat actions.json | ./cmux-hub --actions -
```

### Options

```
-p, --port <port>      Server port (default: 4567)
-a, --actions <file>   Toolbar actions JSON file (use - for stdin)
--dry-run              Don't connect to cmux socket
--debug                Enable debug logging (also: DEBUG=*)
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
