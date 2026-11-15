# Session Reaper — Monitor Backend Implementation

**Status:** implemented in source; production rollout requires authorization.
**Related:** `session-reaper.js`, `session-controller-adapters.js`,
`reaper-client.js`, `monitor-server/reaper-query.cjs`,
`monitor-server/reaper-scheduler.cjs`, `monitor-server/reaper-actions.cjs`,
`scripts/session-reaper.cjs`.

## Why the backend had to change

The monitor already stored `owner_pid` in the `sessions` table, but
`sessions-query.cjs` never selected it, so `/api/sessions` returned no process
ownership and the reaper classified every session as `RECOVERY_REQUIRED`
(`session has no recorded owner PID`).

The fix is deliberately split:

- **Public `/api/sessions`** stays as it is. It must not expose PID, process
  creation time, executable identity or fencing tokens to a browser.
- **Privileged `POST /api/reaper/sessions`** returns the ownership evidence to an
  authenticated internal caller only.

## 1. Schema — `monitor-server/migrations/005-reaper-owner.sql`

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_started_at text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_executable text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_fencing_token text NOT NULL DEFAULT '';
```

Every column has a default, so the migration is backward compatible: existing
rows and older publishers keep working, and a row that predates the migration is
`RECOVERY_REQUIRED` until it reports again.

## 2. Upsert — `monitor-server/session-upsert.cjs`

The `INSERT ... ON CONFLICT` column list and the `EXCLUDED` update list carry the
five new fields (34 bound parameters in total). Two rules matter:

- a sparse report cannot erase what an earlier report proved
  (`COALESCE(NULLIF(EXCLUDED.x, ''), sessions.x)`);
- `lease_generation` only moves forward (`GREATEST`), so a stale publisher cannot
  lower it.

## 3. Privileged endpoint — `monitor-server/dashboard.cjs`

`POST /api/reaper/sessions` is handled before the public `/api/sessions` route:

- the body is parsed and verified by `verifyReaperRequest()` in
  `monitor-server/reaper-query.cjs`;
- the signature is HMAC-SHA256 over the canonical JSON of the whole payload, so
  changing the action, the machine, the limit or the timestamp invalidates it;
- the payload must carry an ISO `at` timestamp inside a 60-second replay window;
- comparison is constant-time;
- credentials are per machine: `DEVWF_REAPER_SECRETS` is a JSON map of machine
  name to secret, and a request must name a machine that is in the map. Removing
  one entry revokes exactly one host. `DEVWF_REAPER_SECRET` remains a
  single-machine fallback;
- a missing credential answers `401 REAPER_SECRET_MISSING`, an unknown machine
  `401 MACHINE_NOT_AUTHORIZED`, and a missing machine `401 MACHINE_REQUIRED` -
  never an empty result that looks like "no sessions";
- every accepted and refused request is logged with the machine name, never the
  credential.

`buildReaperSessionsQuery()` is the only query that selects `owner_pid`,
`owner_started_at`, `owner_executable` and the lease columns, and it bounds the
limit to 500.

`DEVWF_REAPER_SECRETS` (or the single-machine `DEVWF_REAPER_SECRET`) is
provisioned in the monitor's environment file, never in the browser bundle. The
endpoint returns no secret and no credential.

## 4. Public payload

`collectDashboardPayload()` computes the verified state internally and adds only:

- `reaper_state` — one of `ACTIVE`, `IDLE`, `SUSPECTED_STALE`, `UNREACHABLE`,
  `ORPHANED`, `RECOVERY_REQUIRED`, `ARCHIVED`, or `UNKNOWN` when the privileged
  query is unavailable;
- `reaper_reason` — the human-readable reason;
- `reaper_actions` — the controls the state authorizes.

If the migration is missing or the query fails, the dashboard still renders; the
state is simply `UNKNOWN`.

## 5. Scheduler — `monitor-server/reaper-scheduler.cjs`

One idempotent reconciliation cycle, started once from `dashboard.cjs`:

- `start()` is a no-op when a timer already exists, so there is a single
  scheduler owner;
- `runOnce()` refuses to overlap itself (`ALREADY_RUNNING`);
- the default is dry-run; `DEVWF_REAPER_DRY_RUN=0` is the only switch that
  enables mutation;
- only a confirmed `ORPHANED` plan is archived, and archiving is a phase update,
  never a delete;
- the cycle never stops a process and never releases a lease: those need the
  machine-local controller, which alone can re-verify the process on its host;
- every cycle appends to an in-memory audit trail;
- a failed cycle is logged and the next interval retries, so an interrupted run
  leaves no partial state.

Interval: `DEVWF_REAPER_INTERVAL_MS`, default 5 minutes.

## 6. Authorization table — `monitor-server/reaper-actions.cjs`

The endpoint and the UI read the same table, so the browser can never offer an
action the backend refuses:

| Action | Allowed states | Effect |
|---|---|---|
| `verify` | any | read-only, returns the verified state |
| `checkpoint` | any | read-only |
| `evidence` | any | read-only |
| `archive` | `ORPHANED` only | sets `phase = 'closed'` |
| `stop` | `IDLE` only | always `CONTROLLER_REQUIRED` from the monitor |

`POST /api/reaper/action` requires the monitor write token, recomputes the state
server-side, and refuses an action the state does not authorize with `409`.

## 7. Machine-local controllers — `session-controller-adapters.js`

- Windows: `Get-CimInstance Win32_Process` (PowerShell CIM) for creation time and
  executable, `wmic` as a fallback for older hosts, `taskkill /PID` without `/F`
  for a graceful request. `wmic` is absent on current Windows 11 builds, so CIM
  is the primary provider.
- macOS: `ps -o lstart=` / `ps -o comm=` for identity, `SIGTERM` for a graceful
  stop.

`createMachineController()` refuses a session from another machine, re-verifies
PID + creation time + executable locally, and refuses to stop a PID shared by
more than one session (`SHARED_PROCESS_REFUSED`). A failed graceful request is
reported as `PROCESS_DID_NOT_EXIT`; the reaper never escalates to a force kill.

## 7b. Orphan attestation — `monitor-server/reaper-attestation.cjs`

The monitor cannot inspect another host's process table, so the only path to
`ORPHANED` is a signed attestation from the machine that owns the process.

`POST /api/reaper/attest` verifies the per-machine HMAC, the replay window, the
machine/credential match, and then revalidates every bound field against the
stored row: machine, project binding, PID, process creation time, executable,
lease owner, lease generation and fencing token. The nonce is unique per machine
in `reaper_attestations`, so a captured request cannot be replayed. An
attestation expires after 15 minutes.

The scheduler reads only unconsumed attestations, revalidates them again, and
archives with a conditional statement that repeats the identity check. Lease
release is a separate compare-and-swap that bumps the generation; when it loses
the race the session is archived but the lease is reported unresolved.

Cross-project sessions: one process can host several project bindings. Each
binding is a separate session row and gets its own attestation, so retiring a
binding never touches the process.

## 8. Tests

- `tests/monitor-reaper-api.test.js` — query columns, bounded limit, valid /
  tampered / expired / missing-secret signatures, upsert persistence.
- `tests/monitor-reaper-actions.test.js` — the authorization table.
- `tests/monitor-reaper-scheduler.test.js` — dry-run, orphan-only mutation,
  single-run ownership, idempotent start/stop, row mapping.
- `tests/session-controller-adapters.test.js` — CIM and wmic parsing, `taskkill`
  arguments, `ps` parsing, `SIGTERM`, exit polling, platform selection.
- `tests/session-reaper-integration.test.js` — real isolated fixture processes:
  running, exited, reused PID, legacy session, offline machine, shared PID
  refusal, identity-mismatch refusal, cross-machine refusal, verified stop that
  never touches a sibling fixture, idempotent duplicate reconciliation, lease
  ownership change, unauthorized cleanup, checkpoint preservation.

## 9. Rollout

The executable procedure, including the backup and the read-only verifier, is
`docs/operations/monitor-deployment.md`. In short:

1. Back up the database and `/opt/devwf-monitor`; record path, size and sha256.
2. Apply migration `005`; restart the monitor in observation mode.
3. Provision `DEVWF_REAPER_SECRETS` (one entry per machine); verify a signed
   request returns rows and an unsigned request returns `401`.
4. Deploy the machine-local controllers on MMCH, HELLOWORLD and Mac; verify each
   one reports the same identity the monitor stored.
5. Run `scripts/session-reaper.cjs` in dry-run mode; confirm the states match the
   real processes.
6. Set `DEVWF_REAPER_DRY_RUN=0` only after steps 1-5 pass, and only for orphan
   archival.
7. Enable graceful cleanup only for explicitly disposable sessions.

CI never performs any of these steps.

## 10. Rollback

1. Unset `DEVWF_REAPER_DRY_RUN` (or set it to `1`) and restart the monitor: the
   scheduler returns to observation and mutates nothing.
2. Stop the machine-local controllers.
3. The migration is additive; leaving the columns in place is safe. Dropping them
   is only necessary if the monitor is rolled back to a build that cannot parse
   the wider row, and it discards ownership evidence.

No step in this document kills a process or releases a lease by itself.
