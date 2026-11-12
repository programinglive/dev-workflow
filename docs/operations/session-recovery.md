# Session Recovery & Checkpointing Guide

## How Sessions Are Protected During Updates

1. **Active Session Detection:** Before interrupting or reloading any client service, the Update Supervisor inspects `supervisor/processes.json` and the active session ledger.
2. **Side-by-Side Pinning (`PINNED_ACTIVE_SESSION`):** Any process with an active coding session (`activeCriticalSession: true`) keeps running on its existing runtime directory until `complete_task` or `drop_task` settles the session.
3. **Durable Checkpoints:** When a managed restart is scheduled with `--resume`, `AgentLifecycleAdapter.createSessionCheckpoint()` writes a signed JSON checkpoint in `checkpoints/<checkpointId>.json` containing:
   - `sessionKey` and `taskId`
   - `worktreeLease` (`ownerPid`, `expiresAt`)
   - `preUpgradeRevision` and `targetRevision`
   - `checkpointDigest` (`sha256:<hex>`)

## Recovering a Session After Controller or Host Interruption

- **OpenCode:** Automatically re-establishes the MCP connection via `opencode api post "/api/experimental/mcp/dev-workflow/connect?location[directory]=<dir>"` and resumes the active task via `resume_session`.
- **Codex:** Resumes using the persisted checkpoint and `resume_session` tool call on the next CLI turn.
- **Antigravity:** Preserves the open IDE window; reload the MCP server connection or start a new turn and invoke `resume_session`.
