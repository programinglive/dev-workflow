// Monitor-to-controller restart command channel (Outcome C, dispatch).
//
// The Monitor plans a restart, but only the machine controller may perform it.
// The channel between them is a durable queue: the Monitor enqueues one row per
// target, the controller polls its own machine, executes locally, and reports
// the result. Polling is pull-based, so no inbound access to a machine is
// needed and the signed controller credential stays the only authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTART_COMMAND_STATUS,
  buildCommandsTableSql,
  buildEnqueueQuery,
  buildPendingQuery,
  buildClaimQuery,
  buildCompleteQuery,
  validateEnqueue,
} from '../monitor-server/restart-commands.cjs';

test('the table has a unique open command per machine, session and mode', () => {
  const sql = buildCommandsTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS restart_commands/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS restart_commands_open_unique/);
  assert.match(sql, /WHERE status IN \('pending', 'claimed'\)/);
  assert.match(sql, /status text NOT NULL DEFAULT 'pending'/);
});

test('validateEnqueue accepts a well-formed target', () => {
  assert.deepEqual(
    validateEnqueue([{ machine: 'MMCH', sessionKey: 'ses_a', mode: 'graceful' }]),
    { ok: true },
  );
});

test('validateEnqueue refuses an unknown mode', () => {
  const v = validateEnqueue([{ machine: 'MMCH', sessionKey: 'ses_a', mode: 'nuke' }]);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'UNKNOWN_MODE');
});

test('validateEnqueue refuses an unsafe session key', () => {
  for (const key of ['', '../x', 'a b', 'x'.repeat(300), 42]) {
    const v = validateEnqueue([{ machine: 'MMCH', sessionKey: key, mode: 'graceful' }]);
    assert.equal(v.ok, false, `must refuse ${JSON.stringify(key)}`);
  }
});

test('validateEnqueue refuses a missing machine', () => {
  const v = validateEnqueue([{ sessionKey: 'ses_a', mode: 'graceful' }]);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'MACHINE_REQUIRED');
});

test('buildEnqueueQuery writes one row per target and de-duplicates', () => {
  const q = buildEnqueueQuery([
    { machine: 'MMCH', sessionKey: 'ses_a', mode: 'graceful' },
    { machine: 'Mac', sessionKey: 'ses_b', mode: 'graceful' },
  ]);
  assert.match(q.sql, /INSERT INTO restart_commands/);
  assert.match(q.sql, /ON CONFLICT DO NOTHING/);
  assert.match(q.sql, /RETURNING id, machine, session_key, mode/);
  assert.deepEqual(q.params, ['MMCH', 'ses_a', 'graceful', 'Mac', 'ses_b', 'graceful']);
});

test('buildPendingQuery only ever returns one machine', () => {
  const q = buildPendingQuery({ machine: 'MMCH', limit: 20 });
  assert.match(q.sql, /WHERE machine = \$1/);
  assert.match(q.sql, /status = 'pending'/);
  assert.deepEqual(q.params, ['MMCH', 20]);
});

test('buildPendingQuery caps the limit', () => {
  assert.equal(buildPendingQuery({ machine: 'MMCH', limit: 9999 }).params[1], 100);
  // A zero or missing limit means "use the default", the same convention the
  // reaper query already uses.
  assert.equal(buildPendingQuery({ machine: 'MMCH', limit: 0 }).params[1], 20);
});

test('buildClaimQuery is a compare-and-swap on the owning machine', () => {
  const q = buildClaimQuery({ id: 9, machine: 'MMCH' });
  assert.match(q.sql, /SET status = 'claimed', claimed_at = now\(\)/);
  assert.match(q.sql, /WHERE id = \$1/);
  assert.match(q.sql, /AND machine = \$2/);
  assert.match(q.sql, /status = 'pending'/);
  assert.match(q.sql, /claimed_at < now\(\)/);
  assert.equal(q.params[0], 9);
  assert.equal(q.params[1], 'MMCH');
  assert.ok(q.params[2] >= 60_000, 'the stale claim window has a floor');
});

test('buildCompleteQuery is idempotent and scoped to the owning machine', () => {
  const q = buildCompleteQuery({ id: 7, machine: 'MMCH', status: 'done', code: 'RESTARTED', detail: { steps: 3 } });
  assert.match(q.sql, /UPDATE restart_commands/);
  assert.match(q.sql, /WHERE id = \$1 AND machine = \$2 AND status IN \('pending', 'claimed'\)/);
  assert.match(q.sql, /RETURNING id/);
  assert.deepEqual(q.params, [7, 'MMCH', 'done', 'RESTARTED', JSON.stringify({ steps: 3 })]);
});

test('buildCompleteQuery refuses a non-terminal status', () => {
  assert.throws(() => buildCompleteQuery({ id: 1, machine: 'MMCH', status: 'pending', code: 'X' }), /terminal/);
});

test('the command statuses are the ones the queue understands', () => {
  assert.deepEqual(Object.keys(RESTART_COMMAND_STATUS).sort(), ['claimed', 'done', 'failed', 'pending']);
});

// ------------------------------------------------------------ controller client

import { fetchRestartCommands, reportRestartResult } from '../reaper-client.js';

function fakeFetch(capture, body = {}) {
  return async (url, options) => {
    capture.push({ url, options });
    return { ok: true, status: 200, json: async () => body };
  };
}

test('fetchRestartCommands signs a machine-scoped poll', async () => {
  const capture = [];
  await fetchRestartCommands({
    baseUrl: 'http://monitor:3100',
    secret: 'secret',
    machine: 'MMCH',
    limit: 5,
    fetchImpl: fakeFetch(capture, { commands: [{ id: 1 }] }),
  });
  assert.equal(capture[0].url, 'http://monitor:3100/api/reaper/commands');
  const payload = JSON.parse(capture[0].options.body);
  assert.equal(payload.machine, 'MMCH');
  assert.equal(payload.action, 'commands');
  assert.equal(payload.limit, 5);
  assert.ok(capture[0].options.headers['x-devwf-reaper-signature']);
  assert.equal(capture[0].options.headers['x-devwf-reaper-signature'].length, 64);
});

test('fetchRestartCommands refuses to poll without a machine', async () => {
  await assert.rejects(
    () => fetchRestartCommands({ baseUrl: 'http://monitor:3100', secret: 'secret' }),
    /machine is required/,
  );
});

test('reportRestartResult signs a terminal result', async () => {
  const capture = [];
  const result = await reportRestartResult({
    baseUrl: 'http://monitor:3100',
    secret: 'secret',
    machine: 'MMCH',
    id: 7,
    status: 'done',
    code: 'RESTARTED',
    detail: { steps: 2 },
    fetchImpl: fakeFetch(capture, { applied: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  const payload = JSON.parse(capture[0].options.body);
  assert.equal(payload.id, 7);
  assert.equal(payload.status, 'done');
  assert.equal(payload.action, 'result');
  assert.equal(capture[0].url, 'http://monitor:3100/api/reaper/commands/result');
});

test('reportRestartResult requires a numeric id', async () => {
  await assert.rejects(
    () => reportRestartResult({ baseUrl: 'http://m', secret: 's', machine: 'MMCH', id: 'x', status: 'done' }),
    /numeric command id/,
  );
});
