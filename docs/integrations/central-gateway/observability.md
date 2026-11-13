# Central Gateway Observability & Audit

**Version:** 1.0.0  

## Audit Trail Requirements

Every sensitive gateway operation records an audit entry containing:
- `timestamp`: ISO-8601 UTC timestamp.
- `agent`: Initiating AI coding agent (`codex`, `opencode`, `antigravity`).
- `taskId`: Active DevWorkflow canonical task ID.
- `toolName`: Invoked `pb_*` / `infra_*` / `notify_*` tool.
- `collection`: Target collection or resource identifier.
- `decision`: `ALLOW` or `DENY` with policy rule reference.
