# Zettelkasten card chaining

Each task is its own card on the monitor. Starting a second task in the same
agent session no longer overwrites the first one: the new card records the card
it continued from, and the old card is marked `handed-off`.

## Data flow

| Layer | Field | Notes |
|---|---|---|
| `workflow_state` (SQLite) | `parentTask` | `{ taskId, title, startedAt }` or `null`. Written by `start_task` from the identity captured before `reset()`. |
| Snapshot (`monitor.js`) | `taskId`, `parentTask` | `taskId` is `state.workflowTaskId`. A parent without an id is dropped. |
| `sessions` (PostgreSQL) | `task_id`, `parent_task_id`, `parent_task_title` | Primary key is `(session_key, task_id)`. |
| `sessions` (PostgreSQL) | `workflow_task_id`, `task_origin_json`, `task_relations_json`, `repo_path`, `repo_remote` | Task-metadata model (rendered by `task-metadata.cjs`, Zettly drawing thumbnails). The reconciled upsert carries both models: metadata describes the task a card tracks, chain columns describe the card's place inside its session. |
| Dashboard | `chain_from`, `chain_to` | Derived per request from the rows already loaded. |

## Behaviour

- **First card of a session**: `parentTask` is `null`, `task_id` is the task id.
- **Second card**: gets its own row; the parent row's `phase` becomes
  `handed-off`, so it leaves the Aktif tab and appears in Riwayat.
- **Older agents** that send no `taskId` keep writing `task_id = ''`, which is
  the pre-chaining identity. One session, one card — exactly as before.
- **Build boxes** are keyed by `(session_key, task_id)`. A card only renders a
  build that its own task reported; a build event, which carries no task id,
  is attached to the newest card of that session only.
- **Session close** (`POST /api/session/close`) still matches by `session_key`
  and therefore closes every card of that session.

## Migration

The monitor schema lives outside this repository, so it is changed by an
explicit, idempotent migration:

```bash
DATABASE_URL=postgres://... node scripts/migrate-monitor-db.cjs
```

The script applies `monitor-server/migrations/*.sql` inside one transaction,
prints the resulting primary key, and rolls back on failure. Running it twice
is a no-op. Preview without touching the database with `--dry-run`.

The migrations:

- `001-card-chaining.sql` — adds the three chain columns and swaps the
  primary key.
- `002-pk-swap.sql` — the same swap, standalone: it only acts when the key
  is NOT already composite, so it is safe to run on any database state
  (001 applied, skipped, or partial).
- `003-task-metadata.sql` — adds the five task-metadata columns for fresh
  installs. The running dashboard also self-heals the two repository columns
  at boot; on the running database this file is usually a quiet no-op.

Order of operations on the production deploy (`/opt/devwf-monitor`,
service `devwf-monitor`):

1. `pg_dump` the `sessions` table into `/opt/devwf-monitor/backups/`.
2. Stop the service.
3. Copy the unified monitor files in (owner `.bak` convention; on the server
   the entry point is `monitor.cjs`, in the repository it is `dashboard.cjs`).
4. Apply the migrations as the table owner, one transaction:
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -d devwf_monitor` with
   `001` + `002` + `003`. Since the 2026-11-08 ownership transfer the table
   owner is the `devwf` role (source `DATABASE_URL` from
   `/etc/devwf-monitor.env`), so no `sudo -u postgres psql` is needed.
5. Start the service and verify `/api/sessions` returns the chain and
   metadata columns.

Steps 2-5 keep the old upsert and the new primary key from ever meeting: the
old code stops before the key swap, and the new code (whose upsert conflicts
on `(session_key, task_id)`) starts only after the composite key exists.

## Ownership

Since 2026-11-08, every table and sequence in `devwf_monitor`
(`events`, `events_id_seq`, `sessions`, `share_links`) is owned by the `devwf`
service role. Schema migrations and any `ALTER TABLE` therefore run as
`devwf` with the service's `DATABASE_URL` — no `sudo -u postgres psql`.
Before the transfer these objects were owned by `postgres`, which forced
every schema change to be escalated. If a newly created object ever shows up
owned by `postgres`, re-attach it in the same single-transaction style:

```sql
ALTER TABLE public.<name> OWNER TO devwf;
ALTER SEQUENCE public.<name>_id_seq OWNER TO devwf;
```

## Rollback

There is no automatic down migration. To go back to one row per session you
must delete the extra card rows first, then restore `PRIMARY KEY (session_key)`:

```sql
DELETE FROM sessions WHERE task_id <> '';
ALTER TABLE sessions DROP CONSTRAINT sessions_pkey;
ALTER TABLE sessions ADD PRIMARY KEY (session_key);
```

Do this only with the old monitor build already deployed, otherwise the new
upsert has no matching unique constraint to conflict on.

## Tests

- `tests/workflow-card-chain.test.js` — parent identity in state, clean build.
- `tests/monitor-card-snapshot.test.js` — snapshot fields.
- `tests/monitor-session-cards.test.js` — upsert SQL, hand-off, read queries,
  migration ordering.
- `tests/monitor-card-chain-label.test.js`, `tests/monitor-build-isolation.test.js`
  — label and build ownership helpers.
- `tests/monitor-dashboard-chain.test.js` — dashboard wiring.
- `tests/monitor-card-chain-behavior.test.js` — real PostgreSQL: two cards in
  one session, hand-off, legacy row, metadata next to the chain identity,
  and a twice-applied migration.
- `tests/monitor-upsert-behavior.test.js` — real PostgreSQL against the full
  production table shape: empty reports must not erase task identity,
  repository, or the agent-tool label.

## Rollout status (as of 8 November 2026, release v1.24.1)

- Client and managed release: promoted on build-host.example (`/var/lib/devwf-releases/
  current.json` = revision `02542e1`); workstations pick it up on the next
  MCP reconnect.
- Monitor database: the three card-chaining columns were added to
  `devwf_monitor.sessions` (a `pg_dump` of the table is kept under
  `/opt/devwf-monitor/backups/`). The primary-key swap and the unified monitor
  code deploy are **deliberately not applied yet**, because the deployed
  monitor on db-host.example tracks a different implementation of the same
  task: `origin/feat/zettelkasten-card-chaining` (commit `f2ac45d`, 7 Nov),
  a task-metadata model (`workflow_task_id`, `task_origin_json`,
  `task_relations_json`, `task-metadata.cjs`, Zettly drawing thumbnails) that
  is not in this repository's main line. Swapping the primary key before that
  branch is reconciled would leave the deployed upsert failing on every
  ingest.
- This branch was therefore pushed under a separate ref
  (`feat/zettelkasten-card-chaining-v1241`) to keep both implementations
  intact.
- Follow-up: reconcile `f2ac45d` with the composite-key model, add migration
  `002` for the primary-key swap, then run the full migration and restart
  `devwf-monitor`.

## Reconciliation with the f2ac45d task-metadata model (release v1.24.2,
8 November 2026)

The deployed monitor on db-host.example tracked `f2ac45d`'s task-metadata
model, which lived outside the repository. It was reconciled into
`monitor-server/` and the two card models were unified:

- `monitor-server/task-metadata.cjs`, `task-metadata.md`, and
  `task-metadata-migration.sql` came into the repository.
- `session-upsert.cjs` now writes BOTH models: the five metadata columns keep
  the f2ac45d "new task" inheritance rules, and the three chain columns plus
  `buildParentHandoff` carry the composite-key model.
- `dashboard.cjs` is the server lineage (Zettly drawing thumbnails,
  activity box, boot self-heal of the repository columns) with the chain
  layer re-applied: per-card build boxes, `handed-off` hand-off on ingest,
  and `chain_from` / `chain_to` labels on both tabs.
- Migrations `002-pk-swap.sql` (standalone key swap) and
  `003-task-metadata.sql` (metadata columns for fresh installs) joined
  `001-card-chaining.sql` in the runner.
- The compatibility lock of v1.24.1 (the upsert must IGNORE the metadata
  fields) was replaced by the opposite guarantee: the unified upsert carries
  both models, proven on real PostgreSQL by
  `tests/monitor-card-chain-behavior.test.js` and
  `tests/monitor-upsert-behavior.test.js`.

Deploy order on db-host.example: stop `devwf-monitor` → copy the unified
files (with the owner `.bak` convention) → apply `001`+`002`+`003` in one
transaction after a fresh `pg_dump` → start → verify `/api/sessions`.
