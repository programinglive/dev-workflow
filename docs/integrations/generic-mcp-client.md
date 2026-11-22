# Connecting Any Generic MCP Client to DevWorkflow

DevWorkflow implements the standard Model Context Protocol (MCP) over **stdio**.

## Executable & Transport
- **Command:** `dev-workflow-mcp` (or `npx -y @programinglive/dev-workflow`)
- **Transport:** `stdio`
- **Optional Environment Variables:**
  - `DEVWF_AGENT`: Identifier for your client (e.g. `cursor`, `windsurf`, `custom-agent`)
  - `DEV_WORKFLOW_SECURITY_MODE=strict`: Default strict secret-isolation mode

## Standard JSON Block

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "dev-workflow-mcp",
      "args": []
    }
  }
}
```

## Verification
Run `devwf doctor` in your terminal to verify Node.js, Git, SQLite storage, and MCP server startup before connecting your client.
