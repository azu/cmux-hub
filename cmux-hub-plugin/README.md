# cmux-hub plugin for Claude Code

Claude Code plugin that auto-launches [cmux-hub](https://github.com/azu/cmux-hub) on every session.

## What it does

- Installs/updates the `cmux-hub` binary automatically
- Starts cmux-hub on every Claude Code session via SessionStart hook
- Copies default toolbar actions to `~/.claude/cmux-hub.json` on first run

## Install

```bash
claude plugin marketplace add azu/cmux-hub
claude plugin install cmux-hub@cmux-hub-marketplace
```

## Customize actions

Edit `~/.claude/cmux-hub.json` (user-level) or `.claude/cmux-hub.json` (project-level, takes priority) to customize toolbar buttons:

```json
[
  { "label": "Commit", "type": "paste-and-enter", "command": "commit this change" },
  { "label": "Create PR", "type": "paste-and-enter", "command": "create a pull request" },
  { "label": "Push", "type": "shell", "command": "git push" }
]
```

See [Custom Actions](https://github.com/azu/cmux-hub#custom-actions) for all options.

## Skip auto-launch

Set `CMUX_HUB_NO_AUTOSTART=1` in your project's `.claude/settings.json` to prevent the plugin from starting cmux-hub automatically:

```json
{
  "env": {
    "CMUX_HUB_NO_AUTOSTART": "1"
  }
}
```

This is useful when developing cmux-hub itself or running a custom dev server. You can still start cmux-hub manually with `/cmux-hub:start`.

## Manual start

Use the `/cmux-hub:start` skill to manually start cmux-hub in the current project. This works even when auto-start is disabled via `CMUX_HUB_NO_AUTOSTART=1`.

## Prerequisites

cmux-hub connects to the cmux Unix socket. See [Prerequisites](https://github.com/azu/cmux-hub#prerequisites) for socket mode configuration.
