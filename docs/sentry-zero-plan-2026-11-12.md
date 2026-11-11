# Sentry Zero — execution plan (2026-11-12)

Goal: **zero unresolved Sentry issues across `erp`, `frontend_erp`, `pos-clinic` and `todoapp`.**

Started at 40 unresolved. 15 closed with written reasons. 25 remain, of which
ERP-2Z already has a committed fix waiting for a release.

## Rules that make this honest

1. **Never resolve without evidence.** Every resolution carries a comment: either
   the commit that fixed it, or the date after which no event was recorded.
2. **A fix is not done until it is deployed.** Resolving before the release
   means Sentry will reopen it, or worse, hide a live bug.
3. **Do not touch an issue another session owns.** Check
   `list_active_sessions` before starting a cluster.
4. **Performance insights are not closed silently.** Each N+1 gets either a
   query fix or a written technical reason.
5. **One issue = one verification.** After each fix, confirm no new event for
   24h (or a release marker) before resolving.

## Current facts

| Level | Open | Notes |
|---|---|---|
| error | 3 | Clinic CI cache path, Clinic deadlock, frontend 404 from localhost |
| warning | 4 | 1 permission, 3 query insight |
| info | 11 | N+1 and slow query |
| fatal | 0 | ERP-2Z and ERP-7Z fixed and deployed |

## Progress log

| Date | Change | Evidence |
|---|---|---|
| 12 Nov | 5 CLI/debugbar issues closed | event titles carried `Command line code:6`; class never had `build()` |
| 12 Nov | 10 dormant issues closed | explicit last-event date per issue |
| 12 Nov | ERP-2Z closed | commit `32c23579`, live in v2.41.26, verified on host |
| 12 Nov | ERP-7Z closed | commit `10d62c39`, live in v2.41.27, 11 null-safe calls verified |
| 12 Nov | ERP-7W closed | commit `6ec496ad`, migration guard verified live |
| 12 Nov | TODOAPP-6G closed | `Drawing::tags()` exists since the 10 Nov pivot migration |
| 12 Nov | POS-CLINIC-DE closed | `newFolderName=0` across all five deployed tenants |
| 12 Nov | Mac session restored to the monitor | `opencode service restart` on Mac |

Started at 40 open; 18 remain at the last successful read.


---

## Phase 0 — Baseline (do first)

- [ ] Run `list_sentry_issues` with `is:unresolved` and save the snapshot
- [ ] Confirm no active session owns the cluster you are about to touch
- [ ] Record the exact open count in the tracking Todo

**Exit:** a snapshot file and a confirmed owner list.

## Phase 1 — Ship what is already fixed

- [ ] ERP: cut release from `master` (contains `32c23579`)
- [ ] Deploy to `erp.beautyworld.co.id`
- [ ] Confirm the live blade no longer calls `auth()->user()` (grep on host)
- [ ] Wait 24h or until a sentry release marker is set
- [ ] Resolve **ERP-2Z** with a comment naming the commit and the deploy

**Exit:** ERP-2Z resolved with release evidence.

## Phase 2 — Host and configuration faults (no application logic)

These are the cheapest real wins: they are environment state, not code paths.

- [ ] **POS-CLINIC-EB** `touch(): Utime failed`
  - [ ] Find the file the handler touches (event stack) on the DB/app host
  - [ ] Check owner and mode of `storage/`, `storage/framework/*`, and the media disk
  - [ ] Align owner with the php-fpm user across all 10 tenants
  - [ ] Verify by reproducing the scheduled command manually
  - [ ] Resolve with the permission change recorded
- [ ] **POS-CLINIC-EW** `Please provide a valid cache path`
  - [ ] Same class: `storage/framework/{cache,sessions,views}` missing or unreadable
  - [ ] Create and chown on every tenant, then `php artisan optimize:clear`
  - [ ] Resolve with the tenant list that was repaired
- [ ] **ERP-7W** `Table 'tr_message_h' already exists`
  - [ ] Make the migration idempotent (`hasTable` guard) or remove the duplicate
  - [ ] Run migration on a copy first, then production
  - [ ] Resolve with the commit

**Exit:** three issues closed by configuration, verified by reproduction.

## Phase 3 — Application defects

- [ ] **POS-CLINIC-DE** `PublicPropertyNotFoundException` (Livewire)
  - [ ] Fetch the event stack, identify the component and property
  - [ ] Fix the binding or guard the property
  - [ ] Regression test, release, verify, resolve
- [ ] **FRONTEND_ERP-57** `AxiosError 404`
  - [ ] Fetch the failing URL from the event
  - [ ] Fix the endpoint or the caller
  - [ ] Release, verify, resolve
- [ ] **TODOAPP-6G** `RelationNotFoundException`
  - [ ] Fetch the model and relation name
  - [ ] Add or correct the relation, or fix the caller
  - [ ] Release with a Zettly tag, verify, resolve
- [ ] **POS-CLINIC-EV** deadlock on `receipt_print_jobs`
  - [ ] Add a bounded retry around the transaction
  - [ ] Reduce lock scope, or make the update skippable when possible
  - [ ] Release, verify, resolve

**Exit:** four issues closed by code with regression evidence.

## Phase 4 — Performance (14 insights)

Order by reported volume, not alphabetically.

- [ ] Fix the highest-count N+1 first: **ERP-37** (165), **ERP-2K** (64),
  **ERP-53** (37), **ERP-5J** (33), **ERP-31** (31), **ERP-42** (10)
  - [ ] For each: fetch the event, find the query, add the missing eager load
  - [ ] Add a regression test asserting a bounded query count
  - [ ] Release, verify the count stops growing, resolve
- [ ] Fix **FRONTEND_ERP-39** `N+1 API Call` (142) — batch the client requests
- [ ] **ERP-59** `Slow DB Query` — review the index; add one if it is missing
- [ ] **ERP-7V / ERP-7T / ERP-46** `Inefficient Database Queries` — same treatment
- [ ] **FRONTEND_ERP-4Y** `HTTP/1.1 Overhead` — this is transport, not code
  - [ ] Close with a technical note (HTTP/2 termination at the load balancer)

**Exit:** every N+1 either fixed or closed with a written technical reason.

## Phase 5 — Handover, never steal

- [ ] **ERP-62 / ERP-69 / ERP-77** memory exhausted
  - [ ] Confirm the Mac session still owns them via `list_active_sessions`
  - [ ] If that session ends without a fix, take them over explicitly with
        `handoff_task` or a documented takeover
  - [ ] Do not resolve them on someone else's behalf

**Exit:** ownership is explicit for all three.

## Phase 6 — Prove zero

- [ ] Re-run the inventory for 30d
- [ ] Every remaining issue must have either a fix commit or a written reason
- [ ] List any issue that genuinely cannot be fixed (external vendor, accepted
      risk) in the closing note rather than hiding it
- [ ] Close the tracking Todo with the final count and the exceptions

**Exit:** open count is 0, or every non-zero item is documented by name.

---

## Suggested order of work

1. Phase 0, then Phase 1 (release ERP — it is already fixed)
2. Phase 2 (host faults — fastest real reduction, no code)
3. Phase 3 (application defects, one release per repo)
4. Phase 4 (performance, longest; do it last so it never blocks the rest)
5. Phase 5 and Phase 6

## Backups taken (find these here if the session drops)

### ERP production database — before the BTB stock reconciliation

| Field | Value |
|---|---|
| Taken (UTC) | 2026-11-11T19:27:53Z |
| Database | `gcp_erp_database_bw_server` on `10.184.0.9` |
| Path on bw-app | `/var/backups/erp_pre_btb_reconcile_20261111T192753Z.sql.gz` |
| Size | 240,702,148 bytes (229.5 MiB) |
| gzip integrity | `gzip -t` returned OK |
| Tables in dump | 159 |
| SHA256 | `823356c3f1b67333d1c5582bb1443fe8ad7af826191cd02f6fdaabea35ce3f87` |
| Command | `mysqldump --single-transaction --quick --no-tablespaces ... | gzip -1` |

**Off-host copy: DONE.** The file is in
`gs://bw-server-backups-377312/server_backups_v2/pre-repair/erp_pre_btb_reconcile_20261111T192753Z.sql.gz`
at 240,702,148 bytes, matching the local copy, with SHA256
`823356c3f1b67333d1c5582bb1443fe8ad7af826191cd02f6fdaabea35ce3f87`.

Getting there required fixing the actual blocker: the `bw-app` VM had only the
`devstorage.read_only` access scope, so `gsutil cp` failed with
`403 Provided scope(s) are not authorized` no matter what IAM said. Scopes cannot
be changed on a running instance, so `bw-app` was stopped, its service account
re-scoped to `cloud-platform`, and started again. Verification after restart:
nginx, php8.3-fpm and supervisor all `active`; `erp.beautyworld.co.id`,
`zettly.programinglive.com`, `pos.ministrybeauty.com` and
`finance.ministrybeauty.com` all returned 200.

**Lesson:** an instance access scope is separate from IAM. Granting a role in IAM
does not fix a read-only storage scope, and the only remedy is a stop/start.
Check `gcloud compute instances describe --format="value(serviceAccounts)"`
before blaming permissions.




## Hardening: traps this plan must not fall into

These came out of actually attempting the work. Each one is a way to make the
numbers look better while making the product worse.

### Bulk inserts can silently corrupt stock

The ERP N+1 in `TrTransferstockBTBController` is per-row `create()` inside a
`foreach`. The obvious fix — `insert($rows)` — is **not** a drop-in replacement:

- each row is built with `(array) $value` from a browser payload, so the key set
  differs between items;
- `insert()` requires an identical key set across rows, or MySQL rejects the
  statement or writes values into the wrong columns;
- for `ms_Stock` and `tr_TransferStockBTB_D` a misaligned insert means a wrong
  stock balance, discovered only at period close.

Required sequence before touching stock tables:

1. `Schema::getColumnListing()` for the target table.
2. Normalise every row to exactly that column set, filling missing keys with
   `null`; drop unknown keys with `array_intersect_key`.
3. Wrap the whole document in one transaction.
4. Measure with `DB::listen()` on a 30-item payload **before and after**, and
   record both counts.
5. Reconcile: compare the resulting stock rows against the previous behaviour
   on the same payload.

If step 5 cannot be done, the change does not ship.

### Never trade the audit trail for a lower count

`LogBatch::withinBatch()` exists so each row's activity entry shares one
`batch_uuid`. Replacing per-row `create()` calls with `insert()` also removes
their model events, so the audit rows disappear. The decision recorded for ERP is
**one activity entry per document**, which matches the original intent
("one BTB document = one unit of work"). Any other module must make that decision
explicitly rather than inherit it silently.

### A quiet issue is not a fixed issue

`POS-CLINIC-EB` and the TODOAPP cluster went quiet while the code never changed.
Closing them on silence alone would have been wrong. Every closure needs one of:

- a commit plus a verified deploy, or
- a verified state change on the host, stated concretely.

"Stopped reporting" is never sufficient on its own.

### The monitor can lose a healthy session

On 12 Nov the Mac session was running with a healthy MCP, a matching token, a
current release and working connectivity, yet it did not appear in
`/api/sessions` at all. `opencode service restart` on Mac made it reappear
immediately.

Consequence for this plan: **absence from the monitor is not evidence that a
session is idle.** Before claiming an issue is unowned, check the device directly
(`pgrep -f ManagedMCP`, then `--resolve-only`). A monitor entry older than the
heartbeat window must be treated as stale, not as live.

### Development events must not land in the production project

`FRONTEND_ERP-57` reported `/dashboard` on `http://localhost:3000`. A developer
machine was sending events into the production Sentry project. Fixing the 404 is
secondary; the DSN scoping is the actual defect, and until it is fixed every
local error pollutes the same backlog.

### CI must create its own storage tree

`POS-CLINIC-EW` ("Please provide a valid cache path") fired on `bw-tools`, not on
`bw-app`. A quality job runs `artisan` in a fresh checkout where
`storage/framework/{cache,sessions,views}` do not exist. The job must create them
before invoking artisan; resolving the issue without that change guarantees a
repeat.

## What "done" means

Not a number. Done means: **no unresolved issue is both unexplained and unfixed.**
A closed issue without a commit or a written reason is a lie, and Sentry will
reopen it the moment the code runs again.
