import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { fetchBuildReport } from '../monitor.js';
import { handleBuildReport, handleBuildEstimate } from '../tools/handler-modules/status-handlers.js';

const require = createRequire(import.meta.url);
const { getToolList } = require('../tools/definitions.js');

const T0 = '2026-11-08T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

function projectSummary(over = {}) {
  return {
    project: 'clinic',
    count: 6,
    p50Ms: 240000,
    p90Ms: 360000,
    maxMs: 600000,
    minMs: 180000,
    meanMs: 260000,
    trend: [],
    targets: [{ target: 'npm run verify', count: 6, p50Ms: 240000, p90Ms: 360000 }],
    stages: [{ stage: 'composer-install', count: 6, p50Ms: 60000 }],
    stageOrder: ['composer-install'],
    ...over,
  };
}

const reply = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
const textOf = (response) => (response.content || []).map((part) => part.text).join('\n');

test('fetchBuildReport returns ok false when the monitor URL is missing', async () => {
  const result = await fetchBuildReport({ env: {}, fetchImpl: reply({}) });
  assert.equal(result.ok, false);
  assert.match(result.error, /DEVWF_MONITOR_URL/);
});

test('fetchBuildReport never throws on a network error', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const result = await fetchBuildReport({ env: { DEVWF_MONITOR_URL: 'http://127.0.0.1:1' }, fetchImpl: boom });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('build_report renders p50 and p90 in minutes', async () => {
  const response = await handleBuildReport(
    { days: 30 },
    { env: { DEVWF_MONITOR_URL: 'http://monitor' }, fetchImpl: reply({ window_days: 30, totals: { runs: 6 }, projects: [projectSummary()], slowest: [] }) }
  );
  const text = textOf(response);
  assert.match(text, /clinic/);
  assert.match(text, /p50 4m/);
  assert.match(text, /p90 6m/);
});

test('build_estimate refuses to guess below five samples', async () => {
  const response = await handleBuildEstimate(
    { project: 'clinic', target: 'npm run verify' },
    { env: { DEVWF_MONITOR_URL: 'http://monitor' }, fetchImpl: reply({ window_days: 30, projects: [projectSummary({ count: 4, targets: [{ target: 'npm run verify', count: 4, p50Ms: 240000, p90Ms: 360000 }] })] }) }
  );
  const text = textOf(response);
  assert.match(text, /belum ada baseline/i);
  assert.doesNotMatch(text, /≈/);
});

test('build_estimate shows the live range for a running build', async () => {
  const startedAt = new Date(Date.now() - 60000).toISOString();
  const response = await handleBuildEstimate(
    { project: 'clinic', target: 'npm run verify' },
    {
      env: { DEVWF_MONITOR_URL: 'http://monitor' },
      fetchImpl: reply({ window_days: 30, projects: [projectSummary()] }),
      workflowState: { state: { activeBuild: { status: 'running', target: 'npm run verify', startedAt, updatedAt: new Date().toISOString(), progress: null } } },
    }
  );
  const text = textOf(response);
  assert.match(text, /3m–5m lagi/);
  assert.match(text, /n=6/);
});

test('both build tools are registered', () => {
  const names = getToolList().map((tool) => tool.name);
  assert.ok(names.includes('build_report'));
  assert.ok(names.includes('build_estimate'));
});
