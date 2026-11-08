import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pairBuildRuns, percentile, summarizeRuns } = require('../monitor-server/build-report.cjs');

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
});
