/**
 * The snapshot is the only thing a device sends to the monitor. If the release
 * version is not in it, no amount of database or dashboard work can show it.
 *
 * Run: node --test tests/monitor-snapshot-release.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../monitor.js';

const STATE = { taskDescription: 'x', currentPhase: 'coding' };

test('the snapshot carries the managed release version and revision', () => {
  const snapshot = buildSnapshot({
    state: STATE,
    env: {
      DEVWF_MACHINE: 'MMCH',
      DEVWF_RELEASE_VERSION: '1.28.0',
      DEVWF_RELEASE_REVISION: 'a'.repeat(40),
    },
  });
  assert.equal(snapshot.releaseVersion, '1.28.0');
  assert.equal(snapshot.releaseRevision, 'a'.repeat(40));
});

test('an unmanaged install reports empty strings, not invented values', () => {
  const snapshot = buildSnapshot({ state: STATE, env: { DEVWF_MACHINE: 'MMCH' } });
  assert.equal(snapshot.releaseVersion, '');
  assert.equal(snapshot.releaseRevision, '');
});

test('an oversized value is truncated so it cannot break the write', () => {
  const snapshot = buildSnapshot({
    state: STATE,
    env: { DEVWF_RELEASE_VERSION: 'y'.repeat(200), DEVWF_RELEASE_REVISION: 'z'.repeat(200) },
  });
  assert.equal(snapshot.releaseVersion.length, 40);
  assert.equal(snapshot.releaseRevision.length, 40);
});

test('surrounding whitespace is trimmed rather than stored', () => {
  const snapshot = buildSnapshot({
    state: STATE,
    env: { DEVWF_RELEASE_VERSION: '  1.29.0  ', DEVWF_RELEASE_REVISION: '  ' + 'b'.repeat(40) + '  ' },
  });
  assert.equal(snapshot.releaseVersion, '1.29.0');
  assert.equal(snapshot.releaseRevision, 'b'.repeat(40));
});
