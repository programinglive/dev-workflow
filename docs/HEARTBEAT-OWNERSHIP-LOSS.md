# Heartbeat survival after worktree deletion (19 November 2026)

## Symptom

OpenCode reported the `dev-workflow` MCP server as failed while the other six
servers stayed connected:

```text
dev-workflow: failed
Connection closed: MCP server process exited with code 1
```

Every dev-workflow tool disappeared from the session. The live MCP status
payload carried the decisive detail:

```text
code: PROJECT_OWNERSHIP_LOST
details.operation: writeKernelLockMetadata
details.reason: invalid_target_worktree
details.capabilityWorktree: <deleted-worktree>
```

## Root cause

1. The workflow state was bound to a worktree that was later deleted from disk.
2. `initStartupWorktreeMutex()` registers a heartbeat every 200 seconds
   (`HEARTBEAT_MS = DEFAULT_LOCK_STALE_MS / 3`, `DEFAULT_LOCK_STALE_MS` = 10
   minutes).
3. The heartbeat called `writeKernelLockMetadata()` without a guard
   (`index.js:334`).
4. That function re-validates the capability
   (`process-lock.js:812` -> `assertWorktreeCapabilityMatches`,
   `process-lock.js:545`). A missing directory makes
   `resolveCanonicalWorktreeRoot()` fail, and the function throws
   `ProjectOwnershipLostError` with `invalid_target_worktree`.
5. The exception escaped the `setInterval` callback, terminated the process
   with exit code 1, and the client never auto-reconnected.

The ownership check itself is correct: a deleted worktree must never be treated
as an owned worktree. The defect was the caller: a background diagnostic threw
away the whole server instead of treating ownership loss as recoverable.

## Fix

`refreshWorktreeLockMetadata()` now wraps the metadata write:

- `PROJECT_OWNERSHIP_LOST` is the only caught error. It logs the operation,
  reason, and worktree, unbinds the stale capability from the workflow state,
  releases the OS mutex, and returns `{ ok: false, recovered: true, reason }`.
- Any other error is re-thrown. The heartbeat interval logs it loudly and keeps
  the capability bound so the next tick retries; an unrelated defect is never
  misread as ownership loss.
- The startup metadata write uses the same helper, so a worktree that disappears
  between acquisition and the first write cannot abort startup either.

`runWorktreeHeartbeatTick()` is exported so the recovery path is tested directly
without waiting 200 seconds; the interval is a two-line adapter over it.

## Invariants that did not change

- `writeKernelLockMetadata()` still fails closed with
  `PROJECT_OWNERSHIP_LOST` when the worktree is gone. The recovery happens in
  the caller, never inside the ownership check.
- A capability held by another live process is still refused.
- A live worktree still refreshes its advisory lock metadata on every tick.

## Tests

`tests/heartbeat-ownership-loss.test.js` covers four cases:

1. Deleted worktree: the tick returns `recovered: true`, unbinds the capability,
   releases the OS mutex, and does not throw.
2. Healthy worktree: the tick writes metadata with the current PID, lease token,
   and canonical worktree root, and keeps the capability bound.
3. Injected non-ownership failure (`EIO`): the error propagates and the live
   capability stays bound.
4. Deleted worktree with a direct `writeKernelLockMetadata()` call: the
   ownership check still throws `invalid_target_worktree`.

```bash
node --no-deprecation --import ./tests/setup-env.js --test tests/heartbeat-ownership-loss.test.js
```

## Operator recovery

If a server has already died from this crash, the state repair and reconnect are
separate from the code fix:

```bash
opencode api post '/api/experimental/mcp/dev-workflow/connect?location[directory]=<directory>'
opencode api get  '/api/mcp?location[directory]=<directory>'
```

Active workflow rows whose `projectDir` no longer exists should be reset to
`idle` with their history and task text preserved for audit. Back up the state
database before any repair.
