# AI Coding Client Compatibility Matrix

DevWorkflow supports multiple AI coding clients simultaneously on the same workstation. Each client has a distinct process ownership model:

| Client | Transport Ownership | Automatic MCP Service Reload | Automatic Session Resume | Recovery Classification |
| :--- | :--- | :--- | :--- | :--- |
| **OpenCode** (`opencode`) | Background daemon service per workspace directory | `PASS` (`opencode service restart` + `/api/experimental/mcp/dev-workflow/connect` when idle) | `PASS` (via durable checkpoint + `resume_session`) | Fully automated when no active tool call is in flight |
| **Codex CLI** (`codex`) | Direct `stdio` child process per CLI invocation | `NOT_SUPPORTED` (stdio process bound for invocation lifetime) | `PASS` (via durable checkpoint + next CLI turn) | New turns/sessions immediately load the staged runtime |
| **Antigravity** (`antigravity` / `agy`) | Direct `stdio` child process owned by IDE/CLI | `NOT_SUPPORTED` (never force-kill the user's IDE) | `NOT_SUPPORTED` (`manualResumeRequired: true`) | Side-by-side staging protects active IDE window; reload MCP connection when convenient |
| **Standalone Local MCP** | Direct `node index.js` stdio | `NOT_SUPPORTED` | `PASS` (via local SQLite WAL state) | Standard local restart |
