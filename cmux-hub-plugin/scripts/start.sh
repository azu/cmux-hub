#!/bin/bash
set -euo pipefail

# Allow skipping via env (e.g. for development repos)
if [ "${CMUX_HUB_SKIP:-}" = "1" ]; then
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
