---
description: Manually start cmux-hub (diff viewer) in the current project
---

Start cmux-hub for the current working directory.

Run the following commands:

```bash
# Ensure binary is installed
${CLAUDE_PLUGIN_ROOT}/scripts/ensure-cmux-hub.sh

# Determine actions file
if [ -f ".claude/cmux-hub.json" ]; then
  ACTIONS=".claude/cmux-hub.json"
elif [ -f "${HOME}/.claude/cmux-hub.json" ]; then
  ACTIONS="${HOME}/.claude/cmux-hub.json"
else
  # Copy defaults if no user config exists
  mkdir -p "${HOME}/.claude"
  cp "${CLAUDE_PLUGIN_ROOT}/defaults/actions.json" "${HOME}/.claude/cmux-hub.json"
  ACTIONS="${HOME}/.claude/cmux-hub.json"
fi

# Setup logging
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-hub"
mkdir -p "$LOG_DIR"
PROJECT_NAME="$(basename "$PWD")"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG_FILE="${LOG_DIR}/${PROJECT_NAME}-${TIMESTAMP}.log"

# Start cmux-hub in background
CMUX_HUB="${HOME}/.local/bin/cmux-hub"
echo "[${TIMESTAMP}] Starting cmux-hub (pwd: $PWD)" >> "$LOG_FILE"
"$CMUX_HUB" --actions "$ACTIONS" >> "$LOG_FILE" 2>&1 &
disown
```
