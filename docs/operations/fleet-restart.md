# Fleet restart control surface

The Monitor can plan and audit a restart of the AI clients on MMCH, HELLOWORLD
and Mac. It never stops a remote process itself: only the machine-local
controller can verify and stop a process on its own host.

## Modes

| Mode | What it does |
|---|---|
| `graceful` | Block admission, verify identity, checkpoint, drain, stop, relaunch, restore, verify. Refuses if the work is not checkpointed. |
| `force` | Requires explicit authorization. Verifies identity, checkpoints best-effort, tries a graceful stop, then escalates only for the verified target. |
| `all` | Takes the fleet lock, plans every online machine in order, blocks sessions that need a checkpoint, preserves inactive installations, and refuses a second concurrent request. |

## Endpoints

All are privileged and require `Authorization: Bearer <DEVWF_MONITOR_TOKEN>`.

```
POST /api/fleet/restart          { "mode": "one|graceful|force|all", "sessionKey": "...", "authorization": "..." }
GET  /api/fleet/restart/status   { active, audit }
GET  /api/fleet/restart/audit    { audit }
```

`mode: "all"` plans the fleet and then enqueues one durable command per target
in `restart_commands` (migration 007). A repeated request cannot queue the same
target twice while its command is still pending.

## Controller channel

The queue is pull-based, so no inbound access to a machine is needed:

```
POST /api/reaper/commands          signed by the machine -> its pending commands only
POST /api/reaper/commands/result   signed by the machine -> record the outcome
```

Both are authenticated with the same per-machine HMAC credential as the reaper.
The Monitor filters by machine, so a credential for MMCH can neither read nor
complete a Mac command. A result update only applies while the command is
`pending`, so a replayed report is a no-op.

### Controller CLI

```bash
node scripts/restart-controller.mjs --config ~/devwf-controller/config.json --once
node scripts/restart-controller.mjs --config ... --dry-run
node scripts/restart-controller.mjs --config ...            # poll every 30s
```

Config (mode 600):

```json
{
  "machine": "MMCH",
  "secret": "<this machine's reaper secret>",
  "monitor": "http://monitor-host.example:3100",
  "relaunchCommand": ["C:\\path\\to\\client.exe", "--restore"]
}
```

**Why `relaunchCommand` is required for a real restart.** The controller can
stop a process, but only the client can start it again. Without a configured
relaunch it reports `RELAUNCH_ADAPTER_REQUIRED` and leaves the process running,
because a half restart is worse than no restart.

## Controller-side executor

The controller-side executor is headless and testable:

```bash
node monitor-server/restart-orchestrator.cjs plan    --session session.json --mode graceful
node monitor-server/restart-orchestrator.cjs plan    --session session.json --mode force
node monitor-server/restart-orchestrator.cjs execute --session session.json --mode graceful
node monitor-server/restart-orchestrator.cjs execute --session session.json --mode force --authorize
```

`execute` refuses unless a checkpoint, relaunch and verify adapter are supplied.
The CLI does not invent them: a restart without a real checkpoint is exactly the
failure this design exists to prevent.

## Safety rules

- A process is identified by PID + creation time + executable, never by name.
- A PID claimed by two sessions is never stopped.
- A graceful restart never stops a process before its checkpoint succeeded.
- A force restart needs explicit authorization and still tries graceful first.
- A failed relaunch marks only that target for rollback; healthy targets are not
  rolled back.
- An offline machine is blocked, not fatal.
- A second Restart All is refused while one is active.

## What is not wired yet

Nothing in the dispatch path: the queue, the signed poll, the signed result and
the controller CLI are all implemented. What remains is per-client relaunch
knowledge — each AI CLI is started differently, so `relaunchCommand` must be
configured per machine before a real restart can complete. Without it the
controller stops nothing and reports `RELAUNCH_ADAPTER_REQUIRED`.
