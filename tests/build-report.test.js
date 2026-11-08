import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pairBuildRuns } = require('../monitor-server/build-report.cjs');

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
