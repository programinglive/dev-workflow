'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFleetParity, formatFleetReport } = require('../managed/fleet-status.cjs');

test('evaluateFleetParity detects version and tool drift across machines', () => {
  const payload = {
    fleet: {
      version: '1.32.7',
      revision: '7683c8a26a87',
      tools: [
        { name: 'gcloud', expected: '593.0.0', pinned: true },
        { name: 'node', expected: '24.22.3', pinned: true },
      ],
    },
    machines: [
      {
        machine: 'Mac',
        release_version: '1.32.5',
        release_revision: 'bcfef3a37106',
        last_seen: '2026-11-18T13:57:52.151Z',
        toolchain_json: { gcloud: '590.0.0', node: '24.22.3' },
      },
      {
        machine: 'HELLOWORLD',
        release_version: '1.32.7',
        release_revision: '7683c8a26a87',
        last_seen: '2026-11-18T14:00:00.000Z',
        toolchain_json: { gcloud: '593.0.0', node: '24.22.3' },
      },
    ],
  };

  const report = evaluateFleetParity(payload);
  assert.equal(report.ok, false);
  assert.equal(report.targetVersion, '1.32.7');
  assert.equal(report.machines.length, 2);
  assert.equal(report.machines[0].versionMatch, false);
  assert.deepEqual(report.machines[0].toolDrifts, [
    { name: 'gcloud', actual: '590.0.0', expected: '593.0.0' },
  ]);
  assert.equal(report.machines[1].versionMatch, true);
  assert.deepEqual(report.machines[1].toolDrifts, []);

  const text = formatFleetReport(report);
  assert.match(text, /Mac/);
  assert.match(text, /1\.32\.5/);
  assert.match(text, /gcloud 590\.0\.0 != 593\.0\.0/);
});

test('evaluateFleetParity returns ok=true when all machines match version and pinned tools', () => {
  const payload = {
    fleet: {
      version: '1.32.7',
      revision: '7683c8a26a87',
      tools: [{ name: 'node', expected: '24.22.3', pinned: true }],
    },
    machines: [
      {
        machine: 'Mac',
        release_version: '1.32.7',
        release_revision: '7683c8a26a87',
        toolchain_json: { node: '24.22.3' },
      },
    ],
  };

  const report = evaluateFleetParity(payload);
  assert.equal(report.ok, true);
});
