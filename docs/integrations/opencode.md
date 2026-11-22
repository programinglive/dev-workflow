# Connecting OpenCode to DevWorkflow

## 1. Prerequisites
- Node.js `>=20.0.0`
- `@programinglive/dev-workflow` installed globally (`npm install -g @programinglive/dev-workflow`)

## 2. Configuration (`~/.config/opencode/opencode.json`)

Register DevWorkflow under `mcp`:

```json
{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["dev-workflow-mcp"],
      "enabled": true,
      "environment": {
        "DEVWF_AGENT": "opencode"
      }
    }
  }
}
```

## 3. Verify Connectivity
1. Restart OpenCode (`opencode service restart` or reopen the TUI).
2. Confirm `dev-workflow` reports connected in `/mcp`.
3. Call `get_workflow_status` to verify the handshake.

## 4. Disconnecting Safely
Set `"enabled": false` or remove `dev-workflow` from `opencode.json` and restart OpenCode.
