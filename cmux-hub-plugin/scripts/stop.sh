#!/bin/bash
set -euo pipefail

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-hub"
if [ -z "${CMUX_SURFACE_ID:-}" ]; then
  exit 0
fi

PID_FILE="${LOG_DIR}/cmux-hub-${CMUX_SURFACE_ID}.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 0.2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi
