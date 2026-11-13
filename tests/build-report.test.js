import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pairBuildRuns, percentile, summarizeRuns, estimateBuild, buildReportQuery, buildReportPayload } = require('../monitor-server/build-report.cjs');

const T0 = '2026-11-08T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

function ev(kind, minutes, detail, extra = {}) {
  return {
    at: at(minutes),
    session_key: 'ses_build',
    project_name: 'clinic',
    kind,
    detail: JSON.stringify(detail),
    ...extra,
  };
}

const run = (over) => ({
  project: 'clinic',
  target: 'verify',
  host: 'mmch',
  status: 'succeeded',
  durationMs: 60000,
  at: T0,
  stages: [],
  ...over,
});

// --- pairing -------------------------------------------------------------

test('pairs a start with its success into one run', () => {
  const { runs, unclosed } = pairBuildRuns([
    ev('build_started', 0, { target: 'npm run verify', startedAt: at(0), buildHost: 'mmch' }),
    ev('build_progress', 2, { target: 'npm run verify', stage: 'composer-install', progress: 40, buildHost: 'mmch' }),
    ev('build_succeeded', 4, { target: 'npm run verify', startedAt: at(0), finishedAt: at(4), buildHost: 'mmch' }),
  ]);

  assert.equal(unclosed.length, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].durationMs, 4 * 60000);
  assert.equal(runs[0].project, 'clinic');
  assert.equal(runs[0].host, 'mmch');
  assert.equal(runs[0].target, 'npm run verify');
});

test('a start without a terminal event is unclosed and has no duration', () => {
  const { runs, unclosed } = pairBuildRuns([
    ev('build_started', 0, { target: 'vite build', startedAt: at(0) }),
    ev('build_progress', 3, { target: 'vite build', progress: 50 }),
  ]);

  assert.equal(runs.length, 0);
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].durationMs, null);
});

test('a failed run keeps its status and duration', () => {
  const { runs } = pairBuildRuns([
    ev('build_started', 0, { target: 'npm run verify', startedAt: at(0) }),
    ev('build_failed', 6, { target: 'npm run verify', startedAt: at(0), finishedAt: at(6) }),
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].durationMs, 6 * 60000);
});

test('clock skew clamps duration at zero', () => {
  const { runs } = pairBuildRuns([
    ev('build_started', 0, { target: 'build', startedAt: at(5) }),
    ev('build_succeeded', 1, { target: 'build', startedAt: at(5), finishedAt: at(1) }),
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].durationMs, 0);
});

test('consecutive same-stage progress events do not create zero-length stages', () => {
  const { runs } = pairBuildRuns([
    ev('build_started', 0, { target: 'build', startedAt: at(0), stage: 'composer-install' }),
    ev('build_progress', 1, { target: 'build', stage: 'composer-install', progress: 20 }),
    ev('build_progress', 2, { target: 'build', stage: 'composer-install', progress: 40 }),
    ev('build_progress', 4, { target: 'build', stage: 'pint', progress: 70 }),
    ev('build_succeeded', 6, { target: 'build', startedAt: at(0), finishedAt: at(6) }),
  ]);

  const stages = runs[0].stages;
  assert.deepEqual(stages.map((stage) => stage.stage), ['composer-install', 'pint']);
  assert.equal(stages[0].durationMs, 4 * 60000);
  assert.equal(stages[1].durationMs, 2 * 60000);
});

// --- percentiles and summary --------------------------------------------

test('percentile uses nearest-rank and never interpolates', () => {
  assert.equal(percentile([60, 120, 180, 240, 300], 50), 180);
  assert.equal(percentile([60, 120, 180, 240, 300], 90), 300);
});

test('percentile handles a single sample and an empty list', () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([], 50), null);
});

test('summary counts only succeeded runs in the baseline', () => {
  const summary = summarizeRuns([
    run({ durationMs: 60000 }),
    run({ durationMs: 120000 }),
    run({ durationMs: 180000 }),
    run({ status: 'failed', durationMs: 40000 }),
  ]);
  assert.equal(summary.totals.runs, 4);
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.projects[0].count, 3);
  assert.equal(summary.projects[0].p50Ms, 120000);
  assert.equal(summary.projects[0].maxMs, 180000);
});

test('a project with only failures reports count 0 and no percentiles', () => {
  const summary = summarizeRuns([run({ status: 'failed', durationMs: 40000 })]);
  assert.equal(summary.projects[0].count, 0);
  assert.equal(summary.projects[0].p50Ms, null);
});

test('stage baseline ignores zero-length stages and keeps p50', () => {
  const summary = summarizeRuns([
    run({ stages: [{ stage: 'composer', durationMs: 60000 }, { stage: 'pint', durationMs: 0 }] }),
    run({ stages: [{ stage: 'composer', durationMs: 120000 }] }),
  ]);
  const composer = summary.projects[0].stages.find((stage) => stage.stage === 'composer');
  assert.equal(composer.count, 2);
  assert.equal(composer.p50Ms, 60000); // nearest-rank at p50 picks the lower middle
  assert.equal(summary.projects[0].stages.some((stage) => stage.stage === 'pint'), false);
  assert.deepEqual(summary.projects[0].stageOrder, ['composer']);
});

// --- estimator -----------------------------------------------------------

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const base = (over = {}) => ({ count: 5, p50Ms: 240000, p90Ms: 360000, maxMs: 600000, stages: [], stageOrder: [], ...over });
const live = (over = {}) => ({ status: "running", startedAt: new Date(NOW - 60000).toISOString(), progress: null, progressUpdatedAt: new Date(NOW - 10000).toISOString(), stage: "", ...over });

test("four completed builds produce no estimate", () => {
  const est = estimateBuild({ summary: base({ count: 4 }), run: live(), now: NOW });
  assert.equal(est.available, false);
  assert.equal(est.state, "no-baseline");
  assert.equal(est.sampleCount, 4);
});

test("five completed builds produce a p50-p90 range", () => {
  const est = estimateBuild({ summary: base(), run: live(), now: NOW });
  assert.equal(est.available, true);
  assert.equal(est.state, "on-track");
  assert.equal(est.basis, "history");
  assert.equal(est.remainingLowMs, 180000);
  assert.equal(est.remainingHighMs, 300000);
});

test("progress produces the progress basis", () => {
  const est = estimateBuild({
    summary: base(),
    run: live({ startedAt: new Date(NOW - 120000).toISOString(), progress: 50, progressUpdatedAt: new Date(NOW - 30000).toISOString() }),
    now: NOW,
  });
  assert.equal(est.basis, "progress");
  assert.equal(est.state, "on-track");
  assert.ok(est.remainingLowMs <= 120000);
  assert.ok(est.remainingHighMs >= 120000);
});

test("progress of exactly 0 falls back to history without dividing by zero", () => {
  const est = estimateBuild({ summary: base(), run: live({ progress: 0 }), now: NOW });
  assert.equal(est.basis, "history");
  assert.ok(Number.isFinite(est.remainingLowMs));
});

test("crossing p90 flips the estimate to overdue and drops the number", () => {
  const est = estimateBuild({ summary: base(), run: live({ startedAt: new Date(NOW - 420000).toISOString() }), now: NOW });
  assert.equal(est.state, "overdue");
  assert.equal(est.available, true);
  assert.equal(est.remainingLowMs, null);
  assert.match(est.reason, /p90/);
});

test("unchanged progress for 120s flips it to stalled", () => {
  const est = estimateBuild({
    summary: base(),
    run: live({ startedAt: new Date(NOW - 180000).toISOString(), progress: 40, progressUpdatedAt: new Date(NOW - 130000).toISOString() }),
    now: NOW,
  });
  assert.equal(est.state, "stalled");
  assert.match(est.reason, /no progress/);
});

test("progress going backwards is treated as stalled", () => {
  const est = estimateBuild({ summary: base(), run: live({ progress: 40, previousProgress: 60 }), now: NOW });
  assert.equal(est.state, "stalled");
  assert.match(est.reason, /regressed/);
});

test("progress advancing after a stall clears it and marks revised", () => {
  const est = estimateBuild({
    summary: base(),
    run: live({ startedAt: new Date(NOW - 200000).toISOString(), progress: 55, progressUpdatedAt: new Date(NOW).toISOString() }),
    previous: { state: "stalled", remainingLowMs: 100000, remainingHighMs: 200000 },
    now: NOW,
  });
  assert.equal(est.state, "on-track");
  assert.equal(est.revised, true);
});

test("a failed build produces no ETA and reports the failed duration", () => {
  const est = estimateBuild({
    summary: base(),
    run: live({ status: "failed", startedAt: new Date(NOW - 360000).toISOString() }),
    now: NOW,
  });
  assert.equal(est.available, false);
  assert.equal(est.state, "failed");
  assert.match(est.reason, /failed after 6m/);
});

test("a stage change re-estimates from stage baselines", () => {
  const est = estimateBuild({
    summary: base({ p90Ms: 900000, stages: [{ stage: "composer", p50Ms: 60000, count: 5 }, { stage: "pint", p50Ms: 120000, count: 5 }], stageOrder: ["composer", "pint"] }),
    run: live({ startedAt: new Date(NOW - 300000).toISOString(), stage: "pint", stageStartedAt: new Date(NOW - 30000).toISOString() }),
    now: NOW,
  });
  assert.equal(est.basis, "stage");
  assert.equal(est.remainingLowMs, 90000);
});


test("the query clamps the window to 1..30 days", () => {
  assert.equal(buildReportQuery({ days: 0 }).params[0], "1");
  assert.equal(buildReportQuery({ days: 99 }).params[0], "30");
  assert.equal(buildReportQuery({ days: 7 }).params[0], "7");
});

test("the query adds optional project and host filters as parameters", () => {
  const plain = buildReportQuery({ days: 30 });
  assert.equal(plain.params.length, 1);
  const filtered = buildReportQuery({ days: 30, project: "clinic", host: "mmch" });
  assert.equal(filtered.params.length, 3);
  assert.deepEqual(filtered.params.slice(1), ["clinic", "mmch"]);
  assert.match(filtered.sql, /project_name = \$2/);
});

test("the report payload builds totals, projects and slowest from rows", () => {
  const T0 = "2026-11-08T10:00:00.000Z";
  const at = (m) => new Date(Date.parse(T0) + m * 60000).toISOString();
  const rows = [
    { at: at(0), session_key: "s", project_name: "clinic", kind: "build_started", detail: JSON.stringify({ target: "verify", startedAt: at(0) }) },
    { at: at(4), session_key: "s", project_name: "clinic", kind: "build_succeeded", detail: JSON.stringify({ target: "verify", startedAt: at(0), finishedAt: at(4) }) },
  ];
  const payload = buildReportPayload(rows, { days: 7, now: at(10) });
  assert.equal(payload.window_days, 7);
  assert.equal(payload.totals.runs, 1);
  assert.equal(payload.totals.succeeded, 1);
  assert.equal(payload.projects[0].p50Ms, 240000);
  assert.ok(payload.generated_at);
});
