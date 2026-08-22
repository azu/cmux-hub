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

# Read session_id from hook stdin (Claude Code passes JSON on stdin to hooks).
# Skip when stdin is a TTY so the script is still runnable manually.
HOOK_INPUT=""
if [ ! -t 0 ]; then
  HOOK_INPUT="$(cat)"
fi
SESSION_ID=""
if [ -n "$HOOK_INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SESSION_ID="$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    SESSION_ID="$(printf '%s' "$HOOK_INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("session_id",""))
except Exception:
    pass' 2>/dev/null || true)"
  fi
fi

# Restrict session_id to a safe character class before using it as a filename,
# to prevent path traversal if a future caller passes an unexpected value.
case "$SESSION_ID" in
  ''|*[!A-Za-z0-9_-]*) SESSION_ID="" ;;
esac

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
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-hub"
mkdir -p "$STATE_DIR"
PROJECT_NAME="$(basename "$PWD")"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG_FILE="${STATE_DIR}/${PROJECT_NAME}-${TIMESTAMP}.log"

# Start cmux-hub in background with logging
CMUX_HUB="${HOME}/.local/bin/cmux-hub"
echo "[${TIMESTAMP}] Starting cmux-hub (pwd: $PWD)" >> "$LOG_FILE"
"$CMUX_HUB" --actions "$ACTIONS" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown

# Track PID per session so SessionEnd can reap exactly this session's server
# without disturbing concurrent surfaces.
if [ -n "$SESSION_ID" ]; then
  SESSIONS_DIR="${STATE_DIR}/sessions"
  mkdir -p "$SESSIONS_DIR"
  PID_FILE="${SESSIONS_DIR}/${SESSION_ID}.pid"
  TMP_PID_FILE="${PID_FILE}.tmp.$$"
  printf '%s\n' "$SERVER_PID" > "$TMP_PID_FILE"
  mv "$TMP_PID_FILE" "$PID_FILE"
fi
