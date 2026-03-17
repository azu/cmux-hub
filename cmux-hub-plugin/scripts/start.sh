#!/bin/bash
set -euo pipefail

# Allow skipping auto-start via env (e.g. for development repos)
if [ "${CMUX_HUB_NO_AUTOSTART:-}" = "1" ]; then
  exit 0
fi

# Skip when launched from Claude Desktop (no terminal/cmux available)
if [ "${CLAUDE_CODE_ENTRYPOINT:-}" = "claude-desktop" ]; then
  exit 0
fi

# Skip when not running inside cmux (e.g. claude -p, iterm, alfred)
# CMUX_SURFACE_ID is auto-set by cmux for each surface (see https://cmux.dev/docs/api)
if [ -z "${CMUX_SURFACE_ID:-}" ]; then
  exit 0
fi

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_ACTIONS="${HOME}/.claude/cmux-hub.json"

# Copy default actions to user-level config if not present
if [ ! -f "$USER_ACTIONS" ]; then
  mkdir -p "${HOME}/.claude"
  cp "${PLUGIN_ROOT}/defaults/actions.json" "$USER_ACTIONS"
fi

# Project-local config takes priority over user-level config
if [ -f ".claude/cmux-hub.json" ]; then
  ACTIONS=".claude/cmux-hub.json"
else
  ACTIONS="$USER_ACTIONS"
fi

# Setup logging per project
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-hub"
mkdir -p "$LOG_DIR"
PROJECT_NAME="$(basename "$PWD")"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG_FILE="${LOG_DIR}/${PROJECT_NAME}-${TIMESTAMP}.log"

# Start cmux-hub in background with logging
CMUX_HUB="${HOME}/.local/bin/cmux-hub"
echo "[${TIMESTAMP}] Starting cmux-hub (pwd: $PWD)" >> "$LOG_FILE"
"$CMUX_HUB" --actions "$ACTIONS" >> "$LOG_FILE" 2>&1 &
disown
