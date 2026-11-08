# Build duration report and minute-level estimate — design

Status: approved in chat on 2026-11-08; this document is the written spec the
implementation plan is derived from.

## 1. Problem

Builds are reported live (`report_build_status` → `activeBuild` → dashboard build
box), but nothing keeps the duration history in a queryable form. Two questions
cannot be answered today:

1. "How long will this build take?" — asked before starting and while it runs.
2. "Where does build time go, so we can make it faster?" — asked after several
   builds, when the only trace is the last ten entries in
   `workflow-state.state.buildHistory`, which are per session and never aggregated.

The monitor already stores every build transition in Postgres, so the data exists;
what is missing is derivation, aggregation, an estimate, and a surface.

## 2. What already exists (verified in the repo)

- `tools/handler-modules/workflow-handlers.js::handleReportBuildStatus` normalizes
  the build into `workflowState.state.activeBuild`, appends finished builds to
  `state.buildHistory` (last 10, per session), and reports an event:
  `build_started` | `build_progress` | `build_succeeded` | `build_failed`, with the
  whole normalized state as the JSON `detail`.
- `monitor-server/build-monitor.cjs` owns `normalizeBuildState`,
  `parseEventDetail`, `extractActiveBuildFromEvents`, `formatBuildStatusBlock`,
  `formatElapsedShort`. The normalized state carries `status`, `target`,
  `command`, `stage`, `progress`, `buildHost`, `machine`, `startedAt`,
  `updatedAt`, `finishedAt`.
- `monitor-server/dashboard.cjs` stores events in the `events` table
  (`at`, `session_key`, `machine`, `project_name`, `kind`, `detail`) and already
  reconstructs live builds from them (`kind LIKE 'build_%'`).
- `monitor-server/retention.cjs` prunes events older than
  `DEFAULT_RETENTION_DAYS = 30`, so 30 days is the largest honest window.
- `monitor.js::fetchActiveSessions` is the established pattern for an MCP tool
  reading the monitor: `{ env, fetchImpl, timeoutMs }`, bearer token, never throws,
  returns `{ ok, error, ... }`.
- `monitor-server/history-query.cjs` and `sessions-query.cjs` are the established
  pattern for a *pure* query builder module paired with `node:test` tests, so the
  SQL can be tested without Postgres.

## 3. Approaches considered

**A. Derive at query time from `events` (chosen).** No schema change, no
dual-write, retention already applies. Aggregation happens in JavaScript; at the
current volume (hundreds of build events per month) the query is cheap.

**B. New `builds` table written on terminal events.** Faster percentiles in SQL,
independent of event pruning, but requires a production migration, a backfill, and
a second write path that can drift from the events.

**C. Aggregate in the browser from `/api/events`.** Smallest change, but no stable
API, no MCP tool, and every client recomputes — it does not give the owner a
report.

A is chosen because the data is already there and the feature must be cheap to
keep correct. B stays available if volume grows by an order of magnitude.

## 4. Design

### 4.1 From events to build runs

A **build run** is one `build_started` (or the first event after a terminal one)
followed by `build_succeeded` or `build_failed` for the same `session_key` and
`target`.

- `startedAt` = `detail.startedAt` when present, else the start event's `at`.
- `finishedAt` = `detail.finishedAt` when present, else the terminal event's `at`.
- `durationMs` = `finishedAt - startedAt`, clamped to `>= 0`.
- Runs without a terminal event inside the window are counted as `unclosed` and
  excluded from percentiles; they are never silently treated as successes.
- Status is taken from the terminal event (`succeeded` / `failed`); failed runs are
  reported separately and never feed the estimate.

Stage durations (for optimisation work): consecutive events inside one run whose
`stage` differs; the previous stage owns the interval up to the next event, and
the final stage owns the interval up to `finishedAt`. A run with a single stage
reports that stage as the whole duration.

### 4.2 Percentiles and summary

Per group, over succeeded runs only:

- `count`, `p50`, `p90`, `max`, `min`, `mean`.
- Percentiles use nearest-rank on the ascending durations, so the value is always
  one that actually happened; no interpolation invents a duration.
- `trend` = the last 20 completed runs in chronological order, each
  `{ at, durationMs, status }`, for a sparkline.

Grouping keys, in this order of preference: `project_name`, then `build_host`
(from `detail.buildHost`, falling back to `detail.machine`), then `target`.
The report always includes the project-level group and a stage breakdown for the
`target` that has the most samples.

### 4.3 Estimate rules

An estimate is only produced when `count >= MIN_SAMPLES = 5` successful runs in the
same project **and** target group. Below that the answer is
`{ available: false, sampleCount: n }` with the text
"belum ada baseline (n build)"; the feature must never invent a number.

With a baseline:

- Before starting: `estimate = { p50, p90, sampleCount }` → text
  "≈4m (p50), 6m (p90), n=12".
- While running, two signals are computed and both are shown as a range:
  - progress signal: `elapsed / (progress / 100)` when `progress` is a number
    `> 0` and `< 100`;
  - history signal: `p50`.
  The lower bound is `min(signals)`, the upper bound is `max(p90, max(signals))`.
  When progress is absent or 0 the range is `p50 – p90` and the remaining time is
  `max(0, p50 - elapsed) – max(0, p90 - elapsed)`.
- Every rendering names the basis: "dari progress" or "dari riwayat", so the
  number is never presented as measured truth.

### 4.4 API

`GET /api/builds/report?days=30&project=<optional>&host=<optional>`

- `days` is clamped to `1..30` (the event retention limit).
- Response:

```json
{
  "window_days": 30,
  "generated_at": "2026-11-08T13:00:00.000Z",
  "totals": { "runs": 42, "succeeded": 39, "failed": 3, "unclosed": 2 },
  "projects": [
    {
      "project": "clinic",
      "count": 12,
      "p50_ms": 240000, "p90_ms": 380000, "max_ms": 900000,
      "mean_ms": 260000,
      "trend": [{ "at": "...", "duration_ms": 231000, "status": "succeeded" }],
      "targets": [{ "target": "npm run verify", "count": 8, "p50_ms": 240000, "p90_ms": 300000 }],
      "stages": [{ "stage": "composer-install", "p50_ms": 60000, "count": 8 }]
    }
  ],
  "slowest": [{ "project": "...", "target": "...", "duration_ms": 900000, "at": "..." }],
  "unclosed": [{ "project": "...", "target": "...", "started_at": "..." }]
}
```

The endpoint is read-only and uses the same access model as `/api/sessions`: no
extra token on the Tailscale-bound listener, and it exposes no credentials or file
contents.

### 4.5 MCP tools

- `build_report { days?, project?, host? }` → calls the monitor, renders a compact
  text table (project | n | p50 | p90 | max | last) plus the three slowest
  targets and the stage breakdown for the busiest project.
- `build_estimate { project, target, running? }` → pre-start estimate from the
  monitor. The live remaining range is computed locally from
  `workflowState.state.activeBuild` in the same MCP process (that is the build this
  client is actually running), falling back to the monitor's `active_build` when
  `running` is true and no local build exists.
- Both mirror `fetchActiveSessions`: bearer token, 3 s timeout, never throw; on
  failure they return a readable "monitor tidak terjangkau" line.

### 4.6 Dashboard

- New **Build** tab next to the existing tabs: report table, a 20-point sparkline
  per project, and the unclosed list.
- The existing build box (`renderBuildBox(s.active_build, jNow, s.machine)` in
  `dashboard.cjs`) gains an ETA line: `≈3–5m lagi (p50–p90, n=12)`; without a
  baseline it says `belum ada baseline (n)`.
- The tab is rendered from the same `/api/builds/report` payload as the tool, so
  the human and the agent read the same numbers.

## 5. Components (isolation)

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `monitor-server/build-report.cjs` | pure: pair runs, percentiles, group, estimate, SQL builder | nothing (no DB, no HTTP) |
| `/api/builds/report` route in `dashboard.cjs` | execute the SQL, pass rows to the module, serialize | `build-report.cjs`, `pg` |
| `monitor-server/build-monitor.cjs` | unchanged; owns live-build rendering, reused for the ETA input | — |
| `fetchBuildReport()` in `monitor.js` | HTTP client for the tools, never throws | env, fetch |
| `build_report` / `build_estimate` handlers | render text from the client result | `fetchBuildReport` |
| dashboard Build tab | fetch the endpoint, render table + sparkline | `/api/builds/report` |

The pure module is where every rule lives, so testing it needs no database, no
monitor, and no clock: `now` is always a parameter.

## 6. Testing

- `tests/build-report.test.js` (node:test, no DB):
  - pairing: start→success, start→fail, unclosed run, duplicate progress events;
  - percentile: odd/even counts, single sample, nearest-rank honesty;
  - estimate: cold start at 4 samples returns `available:false`; at 5 returns a
    range; progress signal vs history signal; progress 0/100 edge cases;
  - grouping: project fallback to host then target;
  - SQL builder: window clamp, optional filters, parameter order.
- One dashboard test asserting the page contains the Build tab and the ETA hook
  (the existing dashboard tests read the generated HTML).
- Manual verification on the live monitor with Playwright (tab renders, ETA line
  appears for a running build).

## 7. Rollout

- No migration. Deploy is the documented monitor procedure: `scp` the changed
  `monitor-server/*.cjs` files to `/opt/devwf-monitor`, `systemctl restart
  devwf-monitor`, check `/health` and one `/api/builds/report` call.
- The MCP tools ship with the next managed release (they need the new module in
  the release archive).
- Backfill: none needed; the report starts from the events already retained.

## 8. Risks and limits

- Accuracy is bounded by what `report_build_status` receives: a build that never
  reports a terminal status shows up as `unclosed`, not as a duration.
- Stage timing is only as granular as the reported `stage` strings; a build that
  never changes stage yields one stage equal to the whole build.
- 30 days is the maximum window because events are pruned; a longer window needs
  the `builds` table (approach B) and is out of scope here.
- Percentiles over small samples are noisy; that is why the estimate is a range
  and why `n` is always shown.

## 9. Out of scope

- CI pipeline durations from GitLab (a later phase; separate data source and
  credentials).
- Alerting on slow builds.
- Any change to how `report_build_status` records a build.
