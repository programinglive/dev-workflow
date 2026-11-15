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

## Recovering an Orphaned Session with the Reaper

The Monitor classifies every session from verified process evidence. Use the
following procedure instead of guessing from the "possibly stuck" label.

1. **Read the state, do not infer it.** Open the card on the dashboard. The
   `reaper:` line shows the verified state and reason.

   | State | What it means | What you may do |
   |---|---|---|
   | `ACTIVE` | process alive and reporting | nothing; it is working |
   | `IDLE` | process alive, heartbeat old | `Graceful stop` asks the machine controller |
   | `SUSPECTED_STALE` | process alive, heartbeat overdue | `Verify now` first |
   | `UNREACHABLE` | machine offline | nothing; wait for the machine |
   | `ORPHANED` | process confirmed gone | `Recover orphan` |
   | `RECOVERY_REQUIRED` | identity unverifiable (PID reused, executable changed, legacy row) | `Verify now`, then resolve by hand |
   | `ARCHIVED` | card already closed | nothing |

2. **`ORPHANED` — recover the lease.** `Recover orphan` closes the card only. The
   lease is released by the machine-local controller with a compare-and-swap on
   owner + generation + fencing token; if another process took the lease in the
   meantime the controller refuses and the card is not archived.

3. **`RECOVERY_REQUIRED` — never force it.** The recorded PID now belongs to a
   different process, or the row predates migration `005`. Do not archive and do
   not stop anything. Wait for the machine to report again, or resolve it with
   the owner.

4. **`Graceful stop` is a request, not a kill.** The monitor answers
   `CONTROLLER_REQUIRED`; only the controller on that machine re-verifies the
   process and sends `taskkill` (Windows, without `/F`) or `SIGTERM` (macOS). A
   process that does not exit is reported as `PROCESS_DID_NOT_EXIT` and is left
   running. A PID shared by more than one session is refused with
   `SHARED_PROCESS_REFUSED`.

5. **Dry-run first.** `DEVWF_REAPER_DRY_RUN` defaults to observation. Only a
   confirmed orphan is archived when mutation is enabled, and checkpoint rows are
   never deleted.

6. **Rollback.** Set `DEVWF_REAPER_DRY_RUN=1` and restart the monitor; the
   scheduler returns to observation. Migration `005` is additive and may stay in
   place.
