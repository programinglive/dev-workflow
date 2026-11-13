#!/usr/bin/env bash
# ==============================================================================
# Programinglive Homelab Bootstrap Script for macOS (Mac)
# Installs: RTK (Token Killer), Superpowers (Skills), and Dev-Workflow MCP
#
# This script is a thin wrapper. All OpenCode configuration logic lives in
# scripts/setup-stack.js so Windows and macOS cannot drift apart.
# ==============================================================================

set -euo pipefail

echo "🚀 Starting Homelab Unix/macOS Bootstrap on Mac..."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_SCRIPT="$REPO_ROOT/scripts/setup-stack.js"

if [ ! -f "$SETUP_SCRIPT" ]; then
    echo "✗ Could not find $SETUP_SCRIPT" >&2
    echo "  Run this script from inside a clone of dev-workflow-mcp-server." >&2
    exit 1
fi

# 1. Ensure Node is available (setup-stack.js is a Node script)
if ! command -v node > /dev/null 2>&1; then
    echo "✗ Node.js not found on PATH. Install Node 20+ and re-run." >&2
    exit 1
fi

# 2. Check / install RTK
if ! command -v rtk > /dev/null 2>&1; then
    echo "⚡ Installing RTK via Homebrew..."
    brew install rtk || curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
else
    echo "✓ RTK is already installed."
fi

# 3. Install dependencies BEFORE the MCP server is registered, otherwise the
#    server crashes at startup with ERR_MODULE_NOT_FOUND.
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "📥 Installing dependencies..."
    ( cd "$REPO_ROOT" && npm install --no-audit --no-fund )
else
    echo "✓ Dependencies already installed."
fi

# 4. Configure the stack (config path, plugins, MCP server, RTK hook, verification)
echo ""
echo "⚙️ Configuring OpenCode..."
node "$SETUP_SCRIPT"

echo ""
echo "============================================================="
echo "🎉 MAC HOMELAB BOOTSTRAP COMPLETE!"
echo "============================================================="
echo "Restart OpenCode / terminal and verify with: rtk gain"
