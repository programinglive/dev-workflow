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

The POST returns a plan, not a process action. Each machine controller executes
its own entries.

## Controller CLI

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

There is no Monitor-to-controller command channel. The Monitor produces the
plan and the audit; a controller must fetch and execute it. Until that channel
exists, Restart All is proven at the planner and executor level with fixtures,
not against live clients.
