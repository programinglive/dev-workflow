# Build Duration Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the build events the monitor already stores into a duration report and a minute-level estimate that revises itself when a build gets into trouble.

**Architecture:** One pure module (`monitor-server/build-report.cjs`) owns every rule — pairing events into runs, percentiles, grouping, the estimate and its trouble states, and the SQL builder. The dashboard route, the two MCP tools and the ETA line are thin adapters over it. No new table and no migration.

**Tech Stack:** Node 24, `node:test`, Postgres through the existing `pg` client in `monitor-server/dashboard.cjs`, the existing monitor HTTP pattern in `monitor.js`.

**Spec:** `docs/superpowers/specs/2026-11-08-build-duration-report-design.md`

## Global Constraints

- No new dependencies; no schema migration; no change to `report_build_status`.
- `monitor-server/build-report.cjs` must not import `pg`, `http`, or `child_process` — it takes rows and `now` as parameters.
- Percentiles use nearest-rank on real observed durations; never interpolate.
- `MIN_SAMPLES = 5`; below it the estimate is `available: false` and says "belum ada baseline (n build)".
- Event retention is 30 days, so the report window is clamped to `1..30`.
- Identifiers, comments, test names and commit messages in English; the visible UI copy stays Indonesian as the dashboard already does.
- A build with no terminal event is `unclosed` and never contributes a duration.

## Review Focus

- A run whose `finishedAt` precedes `startedAt` (clock skew between the device and the monitor) must clamp to `0`, not go negative.
- `progress` of exactly `0` or `100` must not divide by zero or claim completion before the terminal event.
- Consecutive events with the same `stage` must not produce zero-length stage entries that skew a stage baseline.
- A project whose runs are all failures must report `available: false`, not a successful-baseline of zero.
- An estimate must stop claiming "on track" the moment `elapsed` passes `p90`, even if `progress` still looks healthy.

---

### Task 1: Pair events into build runs

**Files:**
- Create: `monitor-server/build-report.cjs`
- Test: `tests/build-report.test.js`

**Interfaces:**
- Consumes: rows shaped `{ at, session_key, kind, detail }` where `detail` is the JSON string written by `report_build_status`.
- Produces: `pairBuildRuns(events) -> { runs, unclosed }` with
  `Run = { sessionKey, project, host, target, command, status, startedAt, finishedAt, durationMs, stages }`,
  `stages = [{ stage, durationMs, at }]`.

- [ ] **Step 1: Write the failing tests**

```js
test('pairs a start with its success into one run', ...)
// events: build_started at T0 detail {target:'npm run verify', startedAt:T0}
//         build_succeeded at T0+4m detail {target:'npm run verify', finishedAt:T0+4m}
// expect: runs.length === 1, durationMs === 240000, status 'succeeded', unclosed []

test('a start without a terminal event is unclosed and has no duration', ...)
test('a failed run keeps its status and duration', ...)
test('clock skew clamps duration at zero', ...)   // finishedAt < startedAt
test('consecutive same-stage progress events do not create zero-length stages', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report.test.js`
Expected: FAIL — `pairBuildRuns is not a function`.

- [ ] **Step 3: Implement `pairBuildRuns` in `monitor-server/build-report.cjs`**

Parse `detail` with `JSON.parse` inside `try/catch` (a malformed detail must not throw). Group by `session_key` then by `target`; a new run starts on `build_started` or on the first event after a terminal one. `project` comes from the row's `project_name` (add it to the query in Task 4); `host` from `detail.buildHost || detail.machine`; `target` from `detail.target`. Stages: skip an event whose `stage` equals the previous stage; the interval belongs to the previous stage; the final stage ends at `finishedAt`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build-report.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor-server/build-report.cjs tests/build-report.test.js
git commit -m "feat(builds): pair build events into runs with stage durations"
```

---

### Task 2: Percentiles and the report summary

**Files:**
- Modify: `monitor-server/build-report.cjs`
- Test: `tests/build-report.test.js`

**Interfaces:**
- Consumes: `Run[]` from Task 1.
- Produces:
  - `percentile(sorted, p) -> number | null` (nearest-rank).
  - `summarizeRuns(runs, { trendLimit = 20 }) -> { totals, projects, slowest }`
    with `projects = [{ project, count, p50Ms, p90Ms, maxMs, minMs, meanMs, trend, targets, stages }]`,
    `targets = [{ target, count, p50Ms, p90Ms }]`,
    `stages = [{ stage, count, p50Ms }]`,
    `totals = { runs, succeeded, failed, unclosed }`,
    `slowest = [{ project, target, durationMs, at }]` (top 3).

- [ ] **Step 1: Write the failing tests**

```js
test('percentile uses nearest-rank and never interpolates', ...)
// [60,120,180,240,300] p50 -> 180, p90 -> 300
test('percentile handles a single sample and an empty list', ...)
test('summary counts only succeeded runs in the baseline', ...)
test('a project with only failures reports count 0 and no percentiles', ...)
test('stage baseline ignores zero-length stages and keeps p50', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report.test.js`
Expected: FAIL — `percentile is not a function`.

- [ ] **Step 3: Implement `percentile` and `summarizeRuns`**

Nearest-rank: `index = Math.min(n - 1, Math.max(0, Math.ceil(p / 100 * n) - 1))` over ascending durations. Group by `project`, then `target`, then `stage`. Only `status === 'succeeded'` feeds the baseline; failed and unclosed are counted in `totals` only.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build-report.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor-server/build-report.cjs tests/build-report.test.js
git commit -m "feat(builds): aggregate build durations with nearest-rank percentiles"
```

---

### Task 3: The estimator and its trouble states

**Files:**
- Modify: `monitor-server/build-report.cjs`
- Test: `tests/build-report.test.js`

**Interfaces:**
- Consumes: `ProjectSummary` for one target from Task 2, plus the live build.
- Produces:
  `estimateBuild({ summary, run, now, previous = null, minSamples = 5, stallMs = 120000 }) -> Estimate`
  with
  `Estimate = { available, state, sampleCount, remainingLowMs, remainingHighMs, totalLowMs, totalHighMs, basis, reason, revised }`
  and `state ∈ {'no-baseline','on-track','overdue','stalled','recovered','failed','succeeded'}`,
  `basis ∈ {'progress','history','stage','none'}`.

- [ ] **Step 1: Write the failing tests**

```js
test('four completed builds produce no estimate', ...)            // available false, 'no-baseline'
test('five completed builds produce a p50-p90 range', ...)         // on-track, basis history
test('progress produces a tighter range than history alone', ...)  // basis progress
test('progress of exactly 0 falls back to history without dividing by zero', ...)
test('crossing p90 flips the estimate to overdue and drops the number', ...)
test('unchanged progress for 120s flips it to stalled', ...)
test('progress going backwards is treated as stalled', ...)
test('progress advancing after a stall clears it and marks revised', ...)
test('a failed build produces no ETA and reports the failed duration', ...)
test('a stage change re-estimates from stage baselines', ...)      // basis stage
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report.test.js`
Expected: FAIL — `estimateBuild is not a function`.

- [ ] **Step 3: Implement `estimateBuild`**

Order of decisions: `failed` → `no-baseline` → `stalled` (progress unchanged for `stallMs`, or regressed) → `overdue` (`elapsed > p90Ms`) → `stage` (stage baselines exist and the stage changed) → `progress` (0 < progress < 100) → `history`. Clamp every remaining value at `>= 0`. `revised` is true when the state differs from `previous.state`, or when both ranges exist and differ by more than 20%.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build-report.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor-server/build-report.cjs tests/build-report.test.js
git commit -m "feat(builds): estimate minutes and revise on stall, overdue or failure"
```

---

### Task 4: The report query and the API endpoint

**Files:**
- Modify: `monitor-server/build-report.cjs` (add `buildReportQuery`)
- Modify: `monitor-server/dashboard.cjs` (route `/api/builds/report`)
- Test: `tests/build-report.test.js` (query builder), `tests/build-report-api.test.js` (route contract with a fake `query`)

**Interfaces:**
- Produces: `buildReportQuery({ days = 30, project = null, host = null }) -> { sql, params }`,
  selecting `at, session_key, project_name, kind, detail` from `events` where
  `kind LIKE 'build_%'` and `at >= now() - ($1 || ' days')::interval`, ordered by `at`.
- Consumes: `pairBuildRuns`, `summarizeRuns`, `estimateBuild`.

- [ ] **Step 1: Write the failing tests**

```js
test('the query clamps the window to 1..30 days', ...)         // days 0 -> 1, days 99 -> 30
test('the query adds optional project and host filters as parameters', ...)
test('the report route returns totals, projects and slowest', ...)  // fake query rows
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report.test.js tests/build-report-api.test.js`
Expected: FAIL — `buildReportQuery is not a function`.

- [ ] **Step 3: Implement the query and the route**

The query returns rows with `project_name`; the route maps rows into runs, calls `summarizeRuns`, adds `window_days` and `generated_at`, and responds `500` with `{ ok: false, error }` on failure. Keep the handler in a named function so the test can call it with a fake `query`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build-report.test.js tests/build-report-api.test.js`
Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor-server/build-report.cjs monitor-server/dashboard.cjs tests/
git commit -m "feat(monitor): expose /api/builds/report"
```

---

### Task 5: MCP tools `build_report` and `build_estimate`

**Files:**
- Modify: `monitor.js` (add `fetchBuildReport`)
- Modify: `tools/definitions.js`, `tools/handler-modules/index.js`, `tools/handler-modules/status-handlers.js`
- Test: `tests/build-report-tools.test.js`

**Interfaces:**
- Consumes: `fetchBuildReport({ env, days, project, host, fetchImpl, timeoutMs }) -> { ok, error?, report? }` mirroring `fetchActiveSessions`, never throwing.
- Produces: tool names `build_report` and `build_estimate` in the registry and dispatcher.

- [ ] **Step 1: Write the failing tests**

```js
test('fetchBuildReport returns ok false when the monitor URL is missing', ...)
test('fetchBuildReport never throws on a network error', ...)
test('build_report renders p50 and p90 in minutes', ...)          // '4m' / '6m'
test('build_estimate refuses to guess below five samples', ...)   // 'belum ada baseline'
test('build_estimate shows the live range for a running build', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report-tools.test.js`
Expected: FAIL — `fetchBuildReport is not a function`.

- [ ] **Step 3: Implement the client and the two tools**

Copy the `fetchActiveSessions` shape exactly (AbortController, bearer token, 3 s). Render durations with `Math.round(ms / 60000)` minutes and show `n`. `build_estimate` reads `workflowState.state.activeBuild` for the live part.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build-report-tools.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor.js tools/ tests/build-report-tools.test.js
git commit -m "feat(tools): add build_report and build_estimate"
```

---

### Task 6: Dashboard Build tab and the live ETA

**Files:**
- Modify: `monitor-server/dashboard.cjs`
- Test: `tests/build-report-dashboard.test.js` (asserts the generated HTML/JS contains the tab, the ETA hook and the trouble labels)

**Interfaces:**
- Consumes: `/api/builds/report` from Task 4 and `estimateBuild` output.
- Produces: tab id `build`, `renderBuildReport(data)`, and `renderEta(activeBuild, estimate)`.

- [ ] **Step 1: Write the failing tests**

```js
test('the dashboard ships a Build tab wired to /api/builds/report', ...)
test('the build box includes an ETA line with p50 and p90', ...)
test('the ETA line has labels for overdue, stalled and failed', ...)   // 'lewat p90', 'tidak ada kemajuan', 'gagal setelah'
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/build-report-dashboard.test.js`
Expected: FAIL — the page has no Build tab.

- [ ] **Step 3: Implement the tab and the ETA line**

Same polling loop as the other tabs; the ETA is computed client-side from the same pure rules (inline the estimation function into the page the way `visibleTaskSessions.toString()` already does). Use the existing warning colour for stalled/overdue.

- [ ] **Step 4: Verify the rendered page script parses**

Run: `node --check` on the extracted inline script (the monitor already has a check for this) and `node --test tests/build-report-dashboard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add monitor-server/dashboard.cjs tests/build-report-dashboard.test.js
git commit -m "feat(monitor): add the Build tab and a live build ETA"
```

---

### Task 7: Full gate, deploy and live verification

**Files:**
- Modify: `docs/monitor-dashboard.md` (deploy list + report section)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 2: Deploy the monitor**

`scp` the changed `monitor-server/*.cjs` to the monitor host, install into `/opt/devwf-monitor`, `systemctl restart devwf-monitor`, then `curl /health` and `curl /api/builds/report`.

- [ ] **Step 3: Verify on the live page**

Playwright: open the dashboard, open the Build tab, confirm the table has at least one project, and confirm the build box shows an ETA line.

- [ ] **Step 4: Commit and record the evidence**

```bash
git add docs/monitor-dashboard.md
git commit -m "docs(monitor): document the build report and its deploy"
```
