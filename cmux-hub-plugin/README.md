# cmux-hub plugin for Claude Code

Claude Code plugin that auto-launches [cmux-hub](https://github.com/azu/cmux-hub) on every session.

## What it does

- Installs/updates the `cmux-hub` binary automatically
- Starts cmux-hub on every Claude Code session via SessionStart hook
- Copies default toolbar actions to `.claude/cmux-hub.json` on first run

## Install

```bash
claude plugin marketplace add azu/cmux-hub
claude plugin install cmux-hub@cmux-hub-marketplace
```

## Customize actions

Edit `.claude/cmux-hub.json` in your project to customize toolbar buttons:

```json
[
  { "label": "Commit", "type": "paste-and-enter", "command": "commit this change" },
  { "label": "Create PR", "type": "paste-and-enter", "command": "create a pull request" },
  { "label": "Push", "type": "shell", "command": "git push" }
]
```

See [Custom Actions](https://github.com/azu/cmux-hub#custom-actions) for all options.

## Prerequisites

cmux-hub connects to the cmux Unix socket. See [Prerequisites](https://github.com/azu/cmux-hub#prerequisites) for socket mode configuration.
