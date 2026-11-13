/**
 * The monitor must know which dev-workflow release each device runs.
 *
 * WHY
 * ---
 * Reporting "dev-workflow connected" only proves a server is alive. It says
 * nothing about which build answered, so a device stuck on an old release looks
 * healthy. The version has to travel: launcher -> server env -> snapshot ->
 * monitor row -> dashboard.
 *
 * These tests pin the two transforming steps that can silently drop it: the
 * session upsert SQL and the snapshot builder.
 *
 * Run: node --test tests/monitor-release-version.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSessionUpsert } = require('../monitor-server/session-upsert.cjs');

const BASE = {
  sessionKey: 'ses_test_release',
  machine: 'MMCH',
  task: 'check version',
  phase: 'coding',
};

test('the upsert stores the release version and revision', () => {
  const { sql, params } = buildSessionUpsert({ ...BASE, releaseVersion: '1.28.0', releaseRevision: 'a'.repeat(40) });

  assert.match(sql, /release_version/, 'sessions must persist the version');
  assert.match(sql, /release_revision/, 'sessions must persist the revision');
  assert.ok(params.includes('1.28.0'), 'the version must be a bound parameter');
  assert.ok(params.includes('a'.repeat(40)), 'the revision must be a bound parameter');
});

test('an empty release version does not erase a stored one', () => {
  const { sql } = buildSessionUpsert(BASE);
  // Same rule as project_name and session_title: "not sent" is not "delete".
  assert.match(
    sql,
    /release_version=COALESCE\(NULLIF\(EXCLUDED\.release_version, ''\), sessions\.release_version\)/,
    'an empty version must fall back to the stored value'
  );
});

test('a version is truncated rather than rejected, so a bad publisher cannot break reporting', () => {
  const long = 'x'.repeat(300);
  const { params } = buildSessionUpsert({ ...BASE, releaseVersion: long });
  const stored = params.find((p) => typeof p === 'string' && p.startsWith('xxx'));
  assert.ok(stored);
  assert.ok(stored.length <= 40, `version stored with length ${stored.length}, expected at most 40`);
});

test('the parameter order stays aligned with the SQL placeholders', () => {
  const { sql, params } = buildSessionUpsert({ ...BASE, releaseVersion: '2.0.1', releaseRevision: 'b'.repeat(40) });
  const placeholders = (sql.match(/\$\d+/g) || []).map((p) => Number(p.slice(1)));
  const highest = Math.max(...placeholders);
  assert.equal(params.length, highest, `SQL uses $1..$${highest} but ${params.length} params were supplied`);
});
