#!/usr/bin/env bash
# ==============================================================================
# Programinglive Homelab Bootstrap Script for macOS (Mac)
# Installs: RTK (Token Killer), Superpowers (Skills), and Dev-Workflow MCP
# ==============================================================================

set -e

echo "🚀 Starting Homelab Unix/macOS Bootstrap on Mac..."

# 1. Check / Install RTK
if ! command -v rtk &> /dev/null; then
    echo "⚡ Installing RTK via Homebrew..."
    brew install rtk || curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
else
    echo "✓ RTK is already installed."
fi

# 2. Setup OpenCode Config Directory
CONFIG_DIR="$HOME/.config/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
NODE_MODULES_DIR="$CONFIG_DIR/node_modules"
SUPERPOWERS_DIR="$NODE_MODULES_DIR/superpowers"

mkdir -p "$PLUGINS_DIR" "$NODE_MODULES_DIR"

# 3. Clone / Update Superpowers
if [ -d "$SUPERPOWERS_DIR" ]; then
    echo "📦 Updating Superpowers..."
    git -C "$SUPERPOWERS_DIR" pull --depth 1
else
    echo "📦 Cloning Superpowers..."
    git clone --depth 1 https://github.com/obra/superpowers.git "$SUPERPOWERS_DIR"
fi

# 4. Clone or Setup Dev-Workflow MCP Server
SERVER_DIR="$HOME/code/dev-workflow-mcp-server"
mkdir -p "$(dirname "$SERVER_DIR")"
if [ ! -d "$SERVER_DIR" ]; then
    echo "🛠️ Cloning dev-workflow-mcp-server..."
    git clone https://github.com/programinglive/dev-workflow-mcp-server.git "$SERVER_DIR"
else
    echo "✓ dev-workflow-mcp-server already exists at $SERVER_DIR"
fi

# 5. Configure opencode.json via Node helper
echo "⚙️ Configuring opencode.json..."
node -e '
const fs = require("fs");
const path = require("path");
const configPath = process.argv[1];
const serverIndex = process.argv[2];

let config = {};
try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    }
} catch (e) {}

config.$schema = config.$schema || "https://opencode.ai/config.json";
config.plugin = Array.isArray(config.plugin) ? config.plugin : [];
if (!config.plugin.includes("superpowers@git+https://github.com/obra/superpowers.git")) {
    config.plugin.push("superpowers@git+https://github.com/obra/superpowers.git");
}

config.mcp = config.mcp || {};
config.mcp["dev-workflow"] = {
    type: "local",
    command: ["node", serverIndex],
    enabled: true
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf8");
console.log("✓ opencode.json updated successfully.");
' "$CONFIG_DIR/opencode.json" "$SERVER_DIR/index.js"

# 6. Register RTK hook
rtk init -g --opencode || true

echo ""
echo "============================================================="
echo "🎉 MAC HOMELAB BOOTSTRAP COMPLETE!"
echo "============================================================="
echo "Restart OpenCode / terminal and verify with: rtk gain"
