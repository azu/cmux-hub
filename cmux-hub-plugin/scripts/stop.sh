#!/bin/bash
set -euo pipefail

# Mirror start.sh skip-conditions: if start.sh skipped, there is no pidfile to read.
if [ "${CMUX_HUB_NO_AUTOSTART:-}" = "1" ]; then
  exit 0
fi
if [ "${CLAUDE_CODE_ENTRYPOINT:-}" = "claude-desktop" ]; then
  exit 0
fi
if [ -z "${CMUX_SURFACE_ID:-}" ]; then
  exit 0
fi

# Read session_id from hook stdin (Claude Code passes JSON on stdin to hooks).
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

# Without a session_id we cannot identify which server to stop, and indiscriminate
# pkill would kill servers owned by concurrent sessions.
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-hub"
PID_FILE="${STATE_DIR}/sessions/${SESSION_ID}.pid"

# Tolerate missing pidfile (start skipped, or already cleaned up).
if [ ! -f "$PID_FILE" ]; then
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
rm -f "$PID_FILE"

# Tolerate empty/non-numeric pidfile contents.
case "$PID" in
  ''|*[!0-9]*) exit 0 ;;
esac

# Tolerate stale pidfile (process already exited).
if ! kill -0 "$PID" 2>/dev/null; then
  exit 0
fi

# Graceful TERM, then KILL after ~500ms to bound the hook's latency.
kill -TERM "$PID" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  if ! kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
  sleep 0.1
done
kill -KILL "$PID" 2>/dev/null || true
exit 0
