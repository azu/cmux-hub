#!/bin/bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
INSTALL_PATH="${INSTALL_DIR}/cmux-hub"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REQUIRED_VERSION=$(grep '"version"' "${PLUGIN_ROOT}/.claude-plugin/plugin.json" | sed 's/.*"version": *"//;s/".*//')

if [ -z "$REQUIRED_VERSION" ]; then
  echo "Failed to read version from plugin.json" >&2
  exit 1
fi

# Check current version
CURRENT_VERSION=""
if [ -x "$INSTALL_PATH" ]; then
  CURRENT_VERSION=$("$INSTALL_PATH" --version 2>/dev/null || echo "")
fi

if [ "$CURRENT_VERSION" = "$REQUIRED_VERSION" ]; then
  exit 0
fi

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ASSET_NAME="cmux-hub-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/azu/cmux-hub/releases/download/v${REQUIRED_VERSION}/${ASSET_NAME}"

echo "Installing cmux-hub v${REQUIRED_VERSION} (${OS}-${ARCH})..."
mkdir -p "$INSTALL_DIR"
curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_PATH}.tmp"
chmod 755 "${INSTALL_PATH}.tmp"
mv "${INSTALL_PATH}.tmp" "$INSTALL_PATH"
echo "Installed cmux-hub v${REQUIRED_VERSION} to ${INSTALL_PATH}"
