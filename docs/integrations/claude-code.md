# Connecting Claude Code to DevWorkflow

## 1. Prerequisites
- Node.js `>=20.0.0`
- `@programinglive/dev-workflow` installed globally (`npm install -g @programinglive/dev-workflow`)
- Claude Code CLI installed

## 2. Register MCP Server

Add DevWorkflow as a stdio MCP server in Claude Code:

```bash
claude mcp add dev-workflow -- dev-workflow-mcp
```

Or add to your `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "dev-workflow-mcp",
      "args": [],
      "env": {
        "DEVWF_AGENT": "claude-code"
      }
    }
  }
}
```

## 3. Verify Connectivity
1. Restart Claude Code.
2. Run `/mcp` inside Claude Code and confirm `dev-workflow` is connected.
3. Ask Claude Code to call `get_workflow_status` or `audit_standards`.

## 4. Disconnecting Safely
```bash
claude mcp remove dev-workflow
```
Local SQLite task history remains intact in `~/.devworkflow/`.
