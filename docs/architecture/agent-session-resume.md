# Agent Session Checkpointing & Resume Architecture

## Design Principles

DevWorkflow never claims universal automatic session resume where an AI client does not support it. Instead, `AgentLifecycleAdapter` persists a cryptographically digested session checkpoint before any managed restart and applies client-specific recovery rules.

## Durable Checkpoint Schema

```json
{
  "checkpointId": "cp_ses_example_9a1b2c3d",
  "sessionKey": "ses_example",
  "agent": "opencode",
  "taskId": "656",
  "projectDir": "/path/to/repository",
  "worktreeLease": {
    "ownerPid": 12345,
    "expiresAt": 1794505000000
  },
  "preUpgradeRevision": "1111111111111111111111111111111111111111",
  "targetRevision": "2222222222222222222222222222222222222222",
  "quiescedAt": "2026-11-12T16:45:00.000Z",
  "checkpointDigest": "sha256:...",
  "status": "CHECKPOINTED"
}
```

## Safety Validations Before Resume

1. **Session Identity Verification:** `resumeSession` verifies `expectedSessionKey === checkpoint.sessionKey` to prevent cross-session state injection.
2. **Worktree Lease Freshness:** If `worktreeLease.expiresAt < Date.now()`, resume is refused with `STALE_WORKTREE_LEASE` so a stale checkpoint never mutates a worktree acquired by another session.
3. **Capability-Honest Recovery:**
   - **OpenCode (`PASS`):** Reloads background service when idle and reconnects `/api/experimental/mcp/dev-workflow/connect`.
   - **Codex (`PASS`):** Records checkpoint state and resumes via CLI session state on next invocation.
   - **Antigravity (`NOT_SUPPORTED` for forced IDE restart):** Never force-closes the IDE window; marks `manualResumeRequired: true` so the user can reload the MCP connection without losing open editor state.
