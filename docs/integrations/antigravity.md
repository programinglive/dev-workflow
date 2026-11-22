# Connecting Antigravity (CLI & IDE) to DevWorkflow

## 1. Prerequisites
- Node.js `>=20.0.0`
- `@programinglive/dev-workflow` installed globally (`npm install -g @programinglive/dev-workflow`)

## 2. Configuration Files
- **Antigravity CLI (`agy`):** `~/.gemini/config/mcp_config.json`
- **Antigravity IDE:** `~/.gemini/antigravity/mcp_config.json`

Add via CLI:

```bash
agy mcp add --env DEVWF_AGENT=antigravity dev-workflow dev-workflow-mcp
```

Or configure JSON directly:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "dev-workflow-mcp",
      "args": [],
      "env": {
        "DEVWF_AGENT": "antigravity"
      }
    }
  }
}
```

## 3. Verify Connectivity
1. Restart Antigravity CLI or IDE.
2. Confirm `dev-workflow` tools are registered and call `get_workflow_status`.

## 4. Disconnecting Safely
Remove `dev-workflow` from `mcp_config.json` and restart Antigravity.
