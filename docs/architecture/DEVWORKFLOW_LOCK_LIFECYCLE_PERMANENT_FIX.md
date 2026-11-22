# DevWorkflow MCP — Permanent Lock Lifecycle Fix

## Problem

`start_task` could be refused indefinitely with:

```text
⚠️ Refused: another task is running in MCP process PID <pid>.
```

Two distinct causes were identified:

1. **Leaked mutex after task termination.** `start_task` acquires the canonical
   worktree kernel mutex and binds it to `WorkflowState`. The terminal handlers
   `handleCompleteTask`, `handleForceCompleteTask` and `handleDropTask` reset and
   saved the state but never released that mutex. A long-lived MCP process kept
   the repository locked after finishing, so the next session in the same repo
   was blocked.

2. **Live-but-idle task owner.** A process that stays alive with a task stuck in
   `coding` keeps both the kernel mutex and the process lock file. The 10-minute
   stale rule never applies because `findActiveForeignTaskInProject` treats a
   live process lock as fresh regardless of the last state write. A kernel mutex
   held by a live process cannot be stolen safely from outside.

## Fix

### 1. Release on every terminal event

`tools/handler-modules/commit-handlers.js` now calls `releaseTerminalTaskMutex`
after the final state write in all three terminal handlers. The release is
deliberately **after** `workflowState.save()` so the last write stays fenced by
the mutex. The capability is unbound and `requireKernelMutex` is cleared; the
next `start_task` re-acquires the mutex.

### 2. Cooperative takeover

A new tool `take_over_task` accepts `projectDir`, `ownerPid`, `reason` and an
explicit `confirmation: "CONFIRM TAKE_OVER <ownerPid>"`.

- It verifies a foreign task exists, that the PID matches, and that the owner
  has not written state for at least `DEFAULT_LOCK_STALE_MS` (10 minutes).
- It writes a durable `takeover-request.json` into the holder's lock directory.
- The holder's heartbeat (`index.js`) detects the request and drops its own task
  through `handleDropTask`. That path closes the Zettly Todo, records history,
  and releases the mutex via fix 1 — no force kill, no silent DoD loss.
- The requester retries `start_task` after one heartbeat (≤ 1 minute).

Fail-closed properties are preserved: a live owner that is still writing is
refused, an unconfirmed request is refused, and a non-matching PID is refused.

## Regression tests

- `tests/task-terminal-lock-release.test.js` — another session can acquire the
  worktree mutex immediately after `complete_task`, `drop_task` and
  `force_complete_task`.
- `tests/takeover-request.test.js` — request round trip, empty-reason refusal,
  and unconfirmed takeover refusal.
- `tests/website-docs-consistency.test.js` — regenerated catalog includes the
  new tool.

## Rollout

Changes to the MCP must be published centrally and synchronized across Codex,
OpenCode and AGY on HELLOWORLD, Mac and MMCH via `node managed/rollout.cjs`,
followed by `node managed/restart-devices.cjs` and reopening the AI CLIs.
