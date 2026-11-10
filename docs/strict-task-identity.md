# Strict task and project identity

Owner instruction, 10 November 2026:

> "still showing tanpa task and in the recap tab still showing tanpa project — that
> is wrong; without a task it cannot be reported as a report, and without a project
> we must make this MCP know that is not allowed."

A monitor card, a history row or a recap line is only worth showing when it answers
two questions: **what** was done, and **where** it was done. A row missing either
one cannot be reported, counted or compared, so it must not exist.

## The rule

| State | Result |
|---|---|
| task **and** project present | A real report. Shown in Aktif, Riwayat and Rekap |
| task missing (project present) | Not a report. Never created, never shown, never counted |
| project missing (task present) | Not a report. Same handling |

`monitor-server/empty-session.cjs` holds the single definition:

```js
function worthReportingPredicate() {
  return `(
    NULLIF(BTRIM(task), '') IS NOT NULL
    AND NULLIF(BTRIM(project_name), '') IS NOT NULL
  )`;
}
```

Every reader imports it: `sessions-query.cjs` (Aktif), `history-query.cjs`
(Riwayat), `project-summary.cjs` (Rekap), and `visible-task-sessions.cjs` (the
browser-side card filter). Because one predicate is shared, a row cannot be
counted in Rekap while being hidden from Riwayat.

## Why the task text is preserved on close

`complete_task` resets local state, so the closing report arrives with an empty
`task`. The previous upsert wrote that empty value straight into the row, which is
why every finished task turned into "tanpa task" and only kept its chat title.

`session-upsert.cjs` now protects both columns:

```sql
task=COALESCE(NULLIF(EXCLUDED.task, ''), sessions.task),
project_name=COALESCE(NULLIF(EXCLUDED.project_name, ''), sessions.project_name),
```

`phase` still changes, so the card leaves Aktif for Riwayat. What it does **not**
lose is the one thing a report needs.

The same reasoning applies to `project_path`, `repo_path`, `repo_remote`,
`session_title`, `agent_tool`, `release_version` and `toolchain_json`: an empty
field means "this report did not know", never "erase what an earlier report
proved".

## Why `start_task` refuses a task without a project

The monitor could only ever guess a project name from the repository path. When
the agent never pinned a repository, the guess was empty and the card was
unreportable from the moment it was created — the defect the owner kept seeing.

`start_task` therefore resolves the project **before** it resets state:

```js
const project = resolveTaskProject(args);
if (!project.ok) return textResponse(project.message);
```

The refusal names the missing thing and the fix, and changes no state:

```
⚠️ Dibatalkan: repo proyek belum ditentukan (...).
   Task tanpa proyek tidak diizinkan oleh Dev Workflow MCP.
   Sebutkan 'projectDir' yang menunjuk ke repository Git (mis. "D:\\code\\clinic") pada 'start_task'.

Task BELUM dimulai; workflow sebelumnya tidak diubah.
```

`claim_factory_task` applies the same rule. It uses, in order: the explicit
`projectDir`, the session's pinned repository, the working directory's repository,
or the Factory project name. If none exists it refuses the claim instead of
creating an unattributable card.

## Recovering history instead of deleting it

Rows written before this change were incomplete, but many of them described real
finished work. Deleting them would have destroyed the only record of that work, so
`scripts/recover-monitor-identities.cjs` restores identity from sources that
already exist:

1. the linked Zettly Todo (`task_relations_json` → `zettly`/`tracks`) — the
   authoritative record of what the task was and which project it belonged to;
2. `repo_path`, which the reporter observed with `git rev-parse --show-toplevel`;
3. a sibling row of the same `session_key` that still carries the project name.

Nothing is invented. A value is written only when a source actually contains it,
and a row with no recoverable task **and** no recoverable project is deleted,
because it can never appear in any report.

```bash
node scripts/recover-monitor-identities.cjs --dry-run            # list only
node scripts/recover-monitor-identities.cjs --todo-snapshot f.json
node scripts/recover-monitor-identities.cjs --delete-unrecoverable
```

`--todo-snapshot` accepts the `{ "<id>": { title, project } }` map gathered through
the authenticated MCP client, which keeps the Zettly credential out of the server
process.

Cleanup of plain junk stays separate and bounded:
`monitor-server/cleanup-empty-sessions.cjs --dry-run`.

## Where each layer is enforced

| Layer | File | Behaviour |
|---|---|---|
| Task start | `tools/handler-modules/workflow-handlers.js` | `resolveTaskProject` refuses before touching state |
| Factory claim | `tools/handler-modules/factory-handlers.js` | Refuses without a resolvable project |
| Ingestion | `monitor-server/dashboard.cjs` | `shouldSkipCreate` refuses to create a row without both fields |
| Storage | `monitor-server/session-upsert.cjs` | `COALESCE(NULLIF(...))` keeps identity when a report is sparse |
| Aktif | `monitor-server/sessions-query.cjs` | Requires both columns |
| Riwayat | `monitor-server/history-query.cjs` | Requires both columns |
| Rekap | `monitor-server/project-summary.cjs` | Requires both columns; `(tanpa proyek)` grouping removed |
| Browser cards | `monitor-server/visible-task-sessions.cjs` | Requires both columns |
| MCP listing | `tools/handler-modules/status-handlers.js` | `list_active_sessions` filters the same way |
| Deploy | `scripts/deploy-monitor.ps1` | Publishes every module the changed artifacts require |

## Verification

- `npm test` — 1681 tests, 1654 passed, 0 failed, 27 skipped (optional database
  integration suites that need PostgreSQL/MySQL).
- Focused suite covering the guard rails:
  `node --no-deprecation --import ./tests/setup-env.js --test tests/monitor-empty-session.test.js tests/monitor-project-summary.test.js tests/monitor-session-upsert.test.js tests/monitor-sessions-query.test.js tests/monitor-visible-tasks.test.cjs tests/project-dir-resolution.test.js tests/factory-handlers.test.js`
  — 77 passed.
- Production, `GET /api/sessions`: 6 active rows, 60 history rows, 20 recap
  projects, `0` rows missing a task and `0` rows missing a project.
- `node monitor-server/cleanup-empty-sessions.cjs --dry-run`: `0` junk rows remain.
