# Zettelkasten Card Chaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every task its own monitor card and link each card to the task it continued from, both directions.

**Architecture:** `start_task` records the previous task identity in `state.parentTask`; `buildSnapshot` carries `taskId` + `parentTask`; the monitor upserts on `(session_key, task_id)` so cards coexist, marks the parent card `handed-off`, and the dashboard renders chain links plus build boxes owned by exactly one card.

**Tech Stack:** Node ESM source, CommonJS monitor modules, `node:test`, PostgreSQL for the monitor, SQLite for local state.

**Spec:** `docs/superpowers/specs/2026-11-08-zettelkasten-card-chaining-design.md`

## Global Constraints

- Monitor migration must be idempotent and safe on a live table; old rows keep `task_id = ''`.
- Node built-in test runner; no new runtime dependencies.
- `handed-off` is a non-active phase everywhere `closed|done|cancelled` is filtered.
- Snapshot without `taskId` must behave exactly like today.
- All new identifiers, comments, and commits in English.

## Review Focus

- Two tasks started back-to-back in one session: the first card must not be overwritten and must not stay "live".
- A card starting while the previous card had an active build: no build box may appear on the new card.
- An older agent build that sends no `taskId`: ingest still works and keeps one row.
- Migration run twice: second run must be a no-op, not an error.
- Session close must close every card of that session, not just the newest.

---

### Task 1: Parent task in local state

**Files:**
- Modify: `workflow-state.js` (`reset()` state shape)
- Modify: `tools/handler-modules/workflow-handlers.js` (`start_task`, around the `previousTaskIdentity` capture)
- Test: `tests/workflow-card-chain.test.js`

**Interfaces:**
- Produces: `state.parentTask = { taskId: string, title: string, startedAt: string } | null`

- [ ] **Step 1: Write the failing test** — start two different tasks through the `start_task` handler on one temp state file; assert the second state has `parentTask.taskId` equal to the first state's `workflowTaskId`, `parentTask.title` equal to the first description, and `activeBuild === null`, `buildHistory.length === 0`.
- [ ] **Step 2: Run it and watch it fail** — `node --no-deprecation --import ./tests/setup-env.js --test tests/workflow-card-chain.test.js` → `parentTask` undefined.
- [ ] **Step 3: Implement** — add `parentTask: null` to `reset()`; in `start_task`, after `reset()` and after `taskStartedAt` is set, assign `previousTaskIdentity.taskDescription ? {taskId: previousTaskIdentity.workflowTaskId, title: previousTaskIdentity.taskDescription, startedAt: previousTaskIdentity.taskStartedAt} : null`. Extend `previousTaskIdentity` to capture `taskStartedAt`.
- [ ] **Step 4: Run the test** — expect PASS.
- [ ] **Step 5: Commit** — `feat(workflow): record the parent task when chaining cards`

### Task 2: Snapshot carries card identity

**Files:**
- Modify: `monitor.js` (`buildSnapshot`)
- Test: `tests/monitor-card-snapshot.test.js`

**Interfaces:**
- Consumes: `state.workflowTaskId`, `state.parentTask` from Task 1
- Produces: snapshot fields `taskId: string`, `parentTask: {taskId,title,startedAt} | null`

- [ ] **Step 1: Write the failing test** — `buildSnapshot({state})` returns `taskId === state.workflowTaskId` and the same `parentTask` object; with no parent it returns `parentTask: null`.
- [ ] **Step 2: Run it and watch it fail** — fields absent.
- [ ] **Step 3: Implement** — add both fields in `buildSnapshot`; normalise `parentTask` to `null` unless it carries a non-empty `taskId`.
- [ ] **Step 4: Run the test** — expect PASS.
- [ ] **Step 5: Commit** — `feat(monitor): send task identity and parent task in the snapshot`

### Task 3: Composite card row in the monitor

**Files:**
- Create: `monitor-server/migrations/001-card-chaining.sql`
- Create: `scripts/migrate-monitor-db.cjs`
- Modify: `monitor-server/session-upsert.cjs`
- Modify: `monitor-server/sessions-query.cjs`
- Modify: `monitor-server/history-query.cjs`
- Test: `tests/monitor-session-cards.test.js`

**Interfaces:**
- Consumes: `body.taskId`, `body.parentTask` from Task 2
- Produces: `buildSessionUpsert(body)` returns `{sql, params}` with `ON CONFLICT (session_key, task_id)` and params ending in `[..., taskId, parentTaskId, parentTaskTitle]`; exported constant `HANDOFF_PHASE = "handed-off"`

- [ ] **Step 1: Write the failing tests** — assert the upsert SQL contains `ON CONFLICT (session_key, task_id)`, lists the three new columns, and that a second statement marks the parent row `handed-off`; assert both read queries select `task_id` and `parent_task_id` and exclude `handed-off` from active results; assert the migration file creates the columns before swapping the primary key.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** — migration SQL: `ADD COLUMN IF NOT EXISTS` × 3, drop the discovered primary key via `DO $$`, then `ADD PRIMARY KEY (session_key, task_id)`. `scripts/migrate-monitor-db.cjs` reads `DATABASE_URL`, wraps the file in a transaction, prints the resulting PK, exits non-zero on failure. Upsert: add columns, change the conflict target, and run the parent hand-off update when `parentTask.taskId` is present.
- [ ] **Step 4: Run the tests** — expect PASS; run `npm run test:db` when PostgreSQL is reachable.
- [ ] **Step 5: Commit** — `feat(monitor): store one card per task with parent hand-off`

### Task 4: Chain label and build ownership helpers

**Files:**
- Create: `monitor-server/card-chain.cjs`
- Test: `tests/monitor-card-chain-label.test.js`
- Test: `tests/monitor-build-isolation.test.js`

**Interfaces:**
- Produces: `chainLabels(card, siblings) -> {from: string, to: string}`; `buildForCard(buildEntry, card) -> object|null`; `cardKey(sessionKey, taskId) -> string`

- [ ] **Step 1: Write the failing tests** — a child card gets `from` = parent title and `to` = `""`; the parent card among siblings gets `to` = child title and `from` = `""`; unrelated cards get both empty. `buildForCard({taskId:'a', build:{...}}, {task_id:'b'}) === null` and returns the build when task ids match; `cardKey` separates two tasks of one session.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** the three pure functions in `monitor-server/card-chain.cjs`.
- [ ] **Step 4: Run the tests** — expect PASS.
- [ ] **Step 5: Commit** — `feat(monitor): add chain label and build ownership helpers`

### Task 5: Dashboard wiring

**Files:**
- Modify: `monitor-server/dashboard.cjs` (ingest map, active list, session card markup, history markup, detail modal)
- Test: `tests/monitor-dashboard-chain.test.js`

**Interfaces:**
- Consumes: Tasks 3 and 4
- Produces: rendered markup containing `continued from` and `continued to` labels, and `active_build` only for the owning card

- [ ] **Step 1: Write the failing test** — source-text and helper-level assertions: the dashboard requires `card-chain.cjs`, attaches `active_build` through `buildForCard`, renders `chainLabels`, and includes `handed-off` in the non-active filter used by the client.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** — key `liveBuildsBySession` by `cardKey`, store `{taskId, build}`, pass `{task_id}` when rendering, add chain labels to the active card and history card, and treat `handed-off` as ended.
- [ ] **Step 4: Run the test** — expect PASS; `node --check monitor-server/dashboard.cjs`.
- [ ] **Step 5: Commit** — `feat(monitor): render card chain links and isolate live build boxes`

### Task 6: Documentation and full verification

**Files:**
- Modify: `docs/monitor-dashboard.md`, `README.md`

- [ ] **Step 1: Document** the card model, the migration command, the `handed-off` phase, and the two chain labels.
- [ ] **Step 2: Run the full suite** — `npm test` (record pass/fail counts).
- [ ] **Step 3: Build** — `npm run build`.
- [ ] **Step 4: Commit** — `docs(monitor): document Zettelkasten card chaining`
- [ ] **Step 5: Release and rollout** — `npm run release`, then apply the migration and publish the release archive per `docs/central-managed-mcp.md`.
