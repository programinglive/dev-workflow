# Zettelkasten card chaining for Dev Workflow Monitor — design

Date: 2026-11-08
Factory task: `45489f0d-d49d-49a4-893c-f5d50bbc291b`
Zettly Todo: #369

## Intent and why

One agent session often works several topics in a row. Today the monitor keeps
exactly **one row per agent session** (`sessions.session_key` is the primary key)
and `start_task` overwrites `taskDescription`, plan, and DoD in place. The
previous topic disappears from the board, history keeps only a loose entry with
no pointer to what replaced it, and the dashboard cannot show that topic B
continued topic A. The goal is one card per task, with explicit
`continued from` / `continued to` references, so a multi-topic session reads as
a Zettelkasten chain instead of a single mutating card.

## Goals

- Every task started in a session becomes its own card that survives the next
  `start_task` in the same session.
- Each card records the card it continued from (id, title, started time).
- The dashboard renders both directions of the link.
- A chained card never inherits the previous card's live build box.

## Non-goals

- Cross-session or cross-project chaining (a new session needs its own card).
- Manual reordering or editing of the chain from the dashboard.
- Renaming or merging historical cards.

## Anti-goals

- Losing the current single-card behaviour for readers that have not been
  updated (older agents keep working with `task_id = ''`).
- Reporting a task as done in Sentry/Factory because a new task started.

## Constraints

- Monitor storage is PostgreSQL owned outside this repo; migration must be
  idempotent and safe on a live table.
- Local state is SQLite keyed `(user_id, project_path, session_key)`; the JSON
  file is an export mirror, not the truth.
- Node built-in test runner (`node --test`), CommonJS monitor modules.
- Old rows already in `sessions` must keep working with `task_id = ''`.

## Approaches considered

1. **Composite card key `(session_key, task_id)`** — one row per task. Requires
   an idempotent DDL migration (three columns plus a primary-key swap) and an
   upsert conflict-target change. Chosen: it is the only option that keeps
   distinct cards per topic while leaving existing queries and rows intact.
2. **Metadata only, no schema change** — keep one row per session, store the
   parent pointer in state and snapshot only. Cheaper, but the previous card
   still vanishes and the link has no target, so the DoD for distinct cards is
   not met.
3. **Separate `session_cards` table** — append-only cards beside a pointer row
   in `sessions`. Achieves the same distinct cards but duplicates the read path
   and adds a second source of truth for phase and progress.

## Design

### State (local, SQLite + JSON mirror)

`reset()` adds `parentTask: null` to the state shape so every state file has the
field. `start_task` captures the previous task identity **before** `reset()` and
writes it back afterwards:

```js
state.parentTask = previous.taskDescription
  ? { taskId: previous.workflowTaskId, title: previous.taskDescription,
      startedAt: previous.taskStartedAt || "" }
  : null;
```

`reset()` already clears `activeBuild` and `buildHistory`, so a new card starts
with no build state locally.

### Snapshot

`buildSnapshot()` adds `taskId` (`state.workflowTaskId`) and `parentTask`
(`{ taskId, title, startedAt }` or `null`). This is the only transport change.

### Monitor storage

Migration `monitor-server/migrations/001-card-chaining.sql`:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_task_title text;
-- drop the existing primary key by discovery, then add the composite one
```

`scripts/migrate-monitor-db.cjs` runs it inside a transaction against
`DATABASE_URL`, is idempotent, and reports the resulting primary key.

`buildSessionUpsert()` writes the three new columns and conflicts on
`(session_key, task_id)`. When a snapshot carries `parentTask.taskId`, the
upsert also marks the parent row `phase = 'handed-off'` so it stops looking
live; `handed-off` joins `closed`, `done`, `cancelled` in every "active" filter.

### Dashboard

`monitor-server/card-chain.cjs` holds the two pure helpers the UI uses:

- `chainLabels(card, siblings)` → `{ from, to }` with the predecessor title and
  the successor title, each `""` when absent.
- `buildForCard(buildEntry, card)` → the build object only when the entry is
  owned by that card, otherwise `null`.

The embedded dashboard renders `↩ continued from "<title>"` on the successor
card, `↪ continued to "<title>"` on the predecessor card in history, and only
shows a build box for the card that reported it.

## Failure handling

- Migration not applied: `ON CONFLICT (session_key, task_id)` fails; the ingest
  route answers with an explicit error instead of silently dropping the card.
  The deploy checklist runs the migration first.
- Snapshot without `taskId` (older agent): upsert proceeds with `task_id = ''`,
  which is exactly the old behaviour.
- Parent card already closed: the hand-off update is a no-op.

## Test strategy

- Unit: `reset()` + `start_task` chaining, snapshot fields, upsert SQL shape,
  chain labels, build attribution, migration idempotency (text + real DB when
  available).
- Integration: two cards in one session coexist in PostgreSQL and the parent
  row becomes `handed-off`; a second card does not inherit the build entry.
- Regression: whole existing suite plus `npm run build`.

## Rollout

Local: tests, build, commit, release tag. Central: apply the migration, then
publish the release archive per `docs/central-managed-mcp.md`. Workstation
rollout uses the managed launcher, which picks the promoted release.
