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

Order of operations on deploy:

1. Run the migration (adds columns, swaps the primary key).
2. Start the new monitor build.
3. The dashboard shows the chain links; old rows keep `task_id = ''`.

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
  one session, hand-off, legacy row, and a twice-applied migration.
