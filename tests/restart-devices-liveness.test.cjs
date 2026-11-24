'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { activeMachinesFromMonitor } = require('../managed/restart-devices.cjs');

test('only recent ACTIVE sessions count as live devices', () => {
  const now = Date.parse('2026-11-25T00:00:00.000Z');
  const payload = {
    sessions: [
      { machine: 'HELLOWORLD', reaper_state: 'ACTIVE', updated_at: '2026-11-24T23:59:00.000Z' },
      { machine: 'MMCH', reaper_state: 'IDLE', updated_at: '2026-11-24T23:59:30.000Z' },
      { machine: 'Mac', reaper_state: 'ACTIVE', updated_at: '2026-11-20T00:00:00.000Z' },
      { machine: 'MMCH', reaper_state: 'ACTIVE', updated_at: '2026-11-24T23:58:00.000Z' },
    ],
  };

  assert.deepEqual([...activeMachinesFromMonitor(payload, now)].sort(), ['HELLOWORLD', 'MMCH']);
});

test('malformed sessions are ignored instead of marking a device live', () => {
  const now = Date.parse('2026-11-25T00:00:00.000Z');
  const payload = {
    sessions: [
      { machine: 'MMCH', reaper_state: 'ACTIVE', updated_at: 'not-a-date' },
      { reaper_state: 'ACTIVE', updated_at: '2026-11-24T23:59:00.000Z' },
      null,
    ],
  };

  assert.equal(activeMachinesFromMonitor(payload, now).size, 0);
});
