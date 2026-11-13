# Junk sessions and the release version on the monitor

Date: **10 November 2026**.

## The complaint

> "masih ada tanpa task muncul di card devworkflow monitor. tanpa task artinya
> itu data sampah, kita ngga bisa buat laporan dengan judul tanpa task."

Two separate defects produced that card, and neither was where it looked.

## Defect 1: the history query had no junk filter

`monitor-server/history-query.cjs` selected:

```sql
WHERE machine <> ''
  AND updated_at > now() - interval
```

Nothing else. Every row in the window became a history card, including rows with
no task and no title, which render as `(tanpa task)`.

The file's own comment explains why a naive `task <> ''` filter is wrong: closing
a task clears `task` on purpose so the row keeps its identity. The correct
predicate is "no task **and** no title **and** no task_id", which is exactly what
`empty-session.cjs` already provided — and which the live host already used. The
repository copy had drifted behind and lost it.

## Defect 2: a project path counted as content

`shouldSkipCreate` decided whether a report may create a row:

```js
const hasContent =
  task || sessionTitle || projectName || projectPath;
```

A client that reported only a `projectPath` therefore created a row with no task
and no title. The card then rendered `(tanpa task)` because the card falls back
to `s.task || s.session_title || '(tanpa task)'` — and a path is not a title.

Fixed: a path is no longer content. Only a task, a session title or a project
**name** make a card something a human can recognise.

## Defect 3: the file that actually runs was not in the repository

The service runs `monitor.cjs`:

```
ExecStart=/usr/bin/env node /opt/devwf-monitor/monitor.cjs
```

`dashboard.cjs` is required by nothing. The repository had `dashboard.cjs` but no
`monitor.cjs`, so every deploy from the repository edited a file the server never
loads. That is why the first deploy appeared to succeed while the page still had
no version pill.

`monitor.cjs` is now in the repository.

## What was deployed

| File | Change |
|---|---|
| `monitor.cjs` | added `versionPill`, called on the active card, the history card and the modal |
| `empty-session.cjs` | `projectPath` no longer counts as content |
| `history-query.cjs` | restored the `worthReportingPredicate` filter |
| `dashboard.cjs` | reconciled: kept the live test-case renderer, kept the repository machine filter |

Backups: `monitor.cjs.bak-20261110-053642`, and
`dashboard.cjs`/`empty-session.cjs`/`history-query.cjs` `.bak-20261110-053113`.

## Result

```
junk rows before : 10
deleted          : 10
junk rows after  : 0

list query       : 4 rows, 0 junk
history query    : 60 rows, 0 junk
page             : versionPill 4 references, renderTestCases 2, release_version 1
```

Every remaining session carries a version:

```
HELLOWORLD  v=1.29.1  task="Migrate all 229 blogspot p"
Mac         v=1.29.1  title="Antigravity not appe"
HELLOWORLD  v=1.28.0  task="Build an isolated GCP VM c"
MMCH        v=1.29.1  task="Reconcile the live Dev Wor"
```

## Tests

`tests/monitor-empty-session.test.js` (9) and
`tests/monitor-dashboard-version.test.js` (8) pin all of it: a path alone must
not create a card, a sparse report for an existing row must not be skipped, the
cleanup must be bounded and must never delete a row that has a `task_id`, the
history query must filter, and the dashboard must consult the shared predicate.

Full suite: 1512 tests, 1482 pass, 3 fail. The 3 are in `workflowState.test.js`,
which this change does not touch; a clean worktree at `origin/main` fails 6 of
the same file, so they are pre-existing and environmental.

## Rollback

```bash
sudo cp -a /opt/devwf-monitor/monitor.cjs.bak-20261110-053642 /opt/devwf-monitor/monitor.cjs
sudo cp -a /opt/devwf-monitor/empty-session.cjs.bak-20261110-053113 /opt/devwf-monitor/empty-session.cjs
sudo cp -a /opt/devwf-monitor/history-query.cjs.bak-20261110-053113 /opt/devwf-monitor/history-query.cjs
sudo systemctl restart devwf-monitor
```

The deleted rows are gone; they were junk by definition and carried no task,
title or project name.
