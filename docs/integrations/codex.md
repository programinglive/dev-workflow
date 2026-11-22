# Connecting OpenAI Codex to DevWorkflow

## 1. Prerequisites
- Node.js `>=20.0.0`
- `@programinglive/dev-workflow` installed globally (`npm install -g @programinglive/dev-workflow`)

## 2. Configuration (`~/.codex/config.toml`)

Add the MCP server block to `~/.codex/config.toml`:

```toml
[mcp_servers.dev-workflow]
command = "dev-workflow-mcp"
args = []

[mcp_servers.dev-workflow.env]
DEVWF_AGENT = "codex"
```

## 3. Verify Connectivity
1. Restart Codex CLI / IDE extension.
2. Confirm `dev-workflow` tools appear in the MCP tool list.
3. Run a read-only check such as `get_workflow_status`.

## 4. Disconnecting Safely
Remove the `[mcp_servers.dev-workflow]` section from `~/.codex/config.toml` and restart Codex.
