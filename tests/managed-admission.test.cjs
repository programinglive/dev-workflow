'use strict';
// Maintenance admission at the ManagedMCP launcher level (Issue B).
//
// The launcher is the only place every managed client passes through, so it is
// the only place a maintenance window can actually stop new launches. These
// tests pin the contract: fail closed on anything unreadable, refuse while
// draining or cutting over, cover every configured root, and make release
// selection race-safe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ADMISSION_FILENAME,
  evaluateAdmission,
  assertAdmission,
  admissionFingerprint,
  readAdmissionFile,
} = require('../managed/admission.cjs');

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devwf-admission-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedAdmission(root, value) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ADMISSION_FILENAME), JSON.stringify(value), 'utf8');
}

const NOW = Date.parse('2026-11-16T00:00:00Z');

test('no admission file means launches are allowed', async (t) => {
  const root = await tempRoot(t);
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, true);
  assert.equal(decision.code, 'ADMISSION_OPEN');
});

test('mode open allows launches', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'open' });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).ok, true);
});

test('mode draining refuses new launches', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining', reason: 'fleet cutover' });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'MAINTENANCE_DRAINING');
  assert.match(decision.message, /draining/i);
});

test('mode cutover refuses new launches', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'cutover', allowedRevisions: ['a'.repeat(40)] });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'MAINTENANCE_CUTOVER');
});

test('malformed admission JSON fails closed', async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ADMISSION_FILENAME), '{ not json', 'utf8');
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_UNREADABLE');
});

test('an unknown mode fails closed', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'paused' });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_INVALID');
});

test('a wrong schema version fails closed', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 99, mode: 'open' });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_INVALID');
});

test('an expired maintenance window fails closed until it is cleared', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, {
    schemaVersion: 1,
    mode: 'draining',
    expiresAt: new Date(NOW - 60_000).toISOString(),
  });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_STALE');
});

test('a future expiry keeps the window active', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, {
    schemaVersion: 1,
    mode: 'draining',
    expiresAt: new Date(NOW + 60_000).toISOString(),
  });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).code, 'MAINTENANCE_DRAINING');
});

test('an active admission in any configured root refuses the launch', async (t) => {
  const primary = await tempRoot(t);
  const secondary = await tempRoot(t);
  await seedAdmission(secondary, { schemaVersion: 1, mode: 'cutover', allowedRevisions: ['a'.repeat(40)] });
  const decision = evaluateAdmission({
    cacheRoot: primary,
    env: { DEVWF_MANAGED_ROOTS: secondary },
    now: NOW,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'MAINTENANCE_CUTOVER');
  assert.equal(decision.file, path.join(secondary, ADMISSION_FILENAME));
});

test('an unreadable admission in a secondary root also fails closed', async (t) => {
  const primary = await tempRoot(t);
  const secondary = await tempRoot(t);
  await fs.mkdir(secondary, { recursive: true });
  await fs.writeFile(path.join(secondary, ADMISSION_FILENAME), 'garbage', 'utf8');
  const decision = evaluateAdmission({
    cacheRoot: primary,
    env: { DEVWF_MANAGED_ROOTS: secondary },
    now: NOW,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_UNREADABLE');
});

test('DEVWF_MAINTENANCE_ADMISSION points at an explicit file', async (t) => {
  const root = await tempRoot(t);
  const explicit = path.join(root, 'custom-admission.json');
  await fs.writeFile(explicit, JSON.stringify({ schemaVersion: 1, mode: 'draining' }), 'utf8');
  const decision = evaluateAdmission({
    cacheRoot: path.join(root, 'unused'),
    env: { DEVWF_MAINTENANCE_ADMISSION: explicit },
    now: NOW,
  });
  assert.equal(decision.code, 'MAINTENANCE_DRAINING');
});

test('a cutover is a hard stop regardless of the revision a caller claims', async (t) => {
  const root = await tempRoot(t);
  // Even a marker that names a revision must not create an exception: the
  // device entry cannot prove its revision, so any revision-based exception is
  // either unreachable or a bypass. The operator reopens with open/clear.
  await seedAdmission(root, {
    schemaVersion: 1,
    mode: 'cutover',
    allowedRevisions: ['a'.repeat(40)],
  });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).code, 'MAINTENANCE_CUTOVER');
});

test('a dangling symlink at the marker path fails closed', async (t) => {
  const root = await tempRoot(t);
  const link = path.join(root, ADMISSION_FILENAME);
  try {
    await fs.symlink(path.join(root, 'missing-target.json'), link);
  } catch {
    t.skip('this platform cannot create symlinks without elevation');
    return;
  }
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false, 'a marker that exists but cannot be read must block');
  assert.equal(decision.code, 'ADMISSION_UNREADABLE');
});

test('assertAdmission throws a coded error so the launcher can report it', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining' });
  assert.throws(
    () => assertAdmission({ cacheRoot: root, env: {}, now: NOW }),
    (error) => error.code === 'MAINTENANCE_DRAINING' && /draining/i.test(error.message),
  );
});

test('the fingerprint changes when the admission file changes', async (t) => {
  const root = await tempRoot(t);
  const before = admissionFingerprint({ cacheRoot: root, env: {} });
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining' });
  const after = admissionFingerprint({ cacheRoot: root, env: {} });
  assert.notEqual(before, after, 'a maintenance window must change the fingerprint');
});

test('the fingerprint is stable when nothing changes', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'open' });
  assert.equal(
    admissionFingerprint({ cacheRoot: root, env: {} }),
    admissionFingerprint({ cacheRoot: root, env: {} }),
  );
});

test('readAdmissionFile distinguishes absent from unreadable', async (t) => {
  const root = await tempRoot(t);
  const absent = readAdmissionFile(path.join(root, ADMISSION_FILENAME));
  assert.equal(absent.status, 'absent');

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ADMISSION_FILENAME), 'nope', 'utf8');
  const unreadable = readAdmissionFile(path.join(root, ADMISSION_FILENAME));
  assert.equal(unreadable.status, 'unreadable');
});

// ------------------------------------------------------------ launcher wiring

const { launchManaged, resolveRelease } = require('../managed/launcher.cjs');
const { runDeviceEntry } = require('../managed/device-entry.cjs');

function fakeChild() {
  return { on() {}, kill() {} };
}

function fakeRelease(revision = 'c'.repeat(40)) {
  return { revision, version: '9.9.9', runtimeRoot: path.join(os.tmpdir(), 'fake-release'), offline: false };
}

test('launchManaged refuses to spawn while draining', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining' });
  let spawned = 0;
  const result = await launchManaged({
    env: {},
    cacheRoot: root,
    now: () => NOW,
    resolveReleaseImpl: async () => fakeRelease(),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MAINTENANCE_DRAINING');
  assert.equal(spawned, 0, 'nothing may be spawned during maintenance');
});

test('launchManaged spawns when admission is open', async (t) => {
  const root = await tempRoot(t);
  let spawned = 0;
  const result = await launchManaged({
    env: {},
    cacheRoot: root,
    now: () => NOW,
    resolveReleaseImpl: async () => fakeRelease(),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned, 1);
});

test('launchManaged abandons the launch when admission changes mid-selection', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'open', reason: 'before' });
  let spawned = 0;
  const result = await launchManaged({
    env: {},
    cacheRoot: root,
    now: () => NOW,
    resolveReleaseImpl: async () => {
      // A maintenance window opens while the release is being selected.
      await seedAdmission(root, { schemaVersion: 1, mode: 'open', reason: 'after' });
      return fakeRelease();
    },
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADMISSION_CHANGED');
  assert.equal(spawned, 0);
});

test('launchManaged refuses during a cutover', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'cutover' });
  let spawned = 0;
  const result = await launchManaged({
    env: {},
    cacheRoot: root,
    now: () => NOW,
    resolveReleaseImpl: async () => fakeRelease(),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MAINTENANCE_CUTOVER');
  assert.equal(spawned, 0);
});

test('resolveRelease itself refuses while draining, so a cached launcher is gated', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining' });
  await assert.rejects(
    () => resolveRelease({ url: 'http://127.0.0.1:1', token: 'x', cacheRoot: root, env: {}, now: () => NOW }),
    (error) => error.code === 'MAINTENANCE_DRAINING',
  );
});

test('runDeviceEntry refuses to start the launcher while draining', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'draining' });
  let spawned = 0;
  const result = runDeviceEntry({
    argv: ['node', 'device-entry.cjs', 'opencode'],
    env: { DEVWF_MANAGED_CACHE: root },
    configPath: path.join(root, 'no-such-config.json'),
    now: () => NOW,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MAINTENANCE_DRAINING');
  assert.equal(spawned, 0, 'the launcher must not be started during maintenance');
});

test('runDeviceEntry starts the launcher when admission is open', async (t) => {
  const root = await tempRoot(t);
  let spawned = 0;
  const result = runDeviceEntry({
    argv: ['node', 'device-entry.cjs', 'opencode'],
    env: { DEVWF_MANAGED_CACHE: root },
    configPath: path.join(root, 'no-such-config.json'),
    now: () => NOW,
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned, 1);
});

test('launchManaged kills its own child if a window opens during spawn', async (t) => {
  const root = await tempRoot(t);
  let killed = 0;
  const result = await launchManaged({
    env: {},
    cacheRoot: root,
    now: () => NOW,
    resolveReleaseImpl: async () => fakeRelease(),
    spawnImpl: () => {
      // The window opens in the gap between the final check and the spawn.
      writeAdmission({ cacheRoot: root, state: { mode: 'draining', reason: 'opened during spawn' } });
      return { on() {}, kill() { killed += 1; } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MAINTENANCE_DRAINING');
  assert.equal(killed, 1, 'the child this launcher started must be stopped');
});

test('a malformed expiry fails closed even when it is an empty string', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'open', expiresAt: '' });
  const decision = evaluateAdmission({ cacheRoot: root, env: {}, now: NOW });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'ADMISSION_INVALID');
});

test('a garbage expiry fails closed', async (t) => {
  const root = await tempRoot(t);
  await seedAdmission(root, { schemaVersion: 1, mode: 'open', expiresAt: 'not-a-date' });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).code, 'ADMISSION_INVALID');
});

test('runDeviceEntry kills its launcher child if a window opens during spawn', async (t) => {
  const root = await tempRoot(t);
  let killed = 0;
  const result = runDeviceEntry({
    argv: ['node', 'device-entry.cjs', 'opencode'],
    env: { DEVWF_MANAGED_CACHE: root },
    configPath: path.join(root, 'no-such-config.json'),
    now: () => NOW,
    spawnImpl: () => {
      writeAdmission({ cacheRoot: root, state: { mode: 'draining', reason: 'opened during spawn' } });
      return { on() {}, kill() { killed += 1; } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MAINTENANCE_DRAINING');
  assert.equal(killed, 1, 'the launcher this entry started must be stopped');
});

test('runDeviceEntry rejects an unsupported client', async (t) => {
  const root = await tempRoot(t);
  assert.throws(
    () => runDeviceEntry({
      argv: ['node', 'device-entry.cjs', 'not-a-client'],
      env: { DEVWF_MANAGED_CACHE: root },
      configPath: path.join(root, 'no-such-config.json'),
      now: () => NOW,
      spawnImpl: () => fakeChild(),
    }),
    /Unsupported MCP client/,
  );
});

// ------------------------------------------------- marker lifecycle and CLI

const { writeAdmission, clearAdmission } = require('../managed/admission.cjs');
const { execFileSync } = require('node:child_process');

test('writeAdmission then drain refuses, and clearAdmission reopens', async (t) => {
  const root = await tempRoot(t);
  writeAdmission({ cacheRoot: root, state: { mode: 'draining', reason: 'test' } });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).code, 'MAINTENANCE_DRAINING');
  clearAdmission({ cacheRoot: root });
  assert.equal(evaluateAdmission({ cacheRoot: root, env: {}, now: NOW }).ok, true);
});

test('writeAdmission refuses an unknown mode', async (t) => {
  const root = await tempRoot(t);
  assert.throws(
    () => writeAdmission({ cacheRoot: root, state: { mode: 'paused' } }),
    /unknown admission mode/,
  );
});

test('the CLI drain/status/clear cycle works end to end', async (t) => {
  const root = await tempRoot(t);
  const cli = path.join(__dirname, '..', 'managed', 'admission.cjs');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  run('drain', '--cache', root, '--reason', 'cli-test');
  const status = JSON.parse(run('status', '--cache', root));
  assert.equal(status.decision.code, 'MAINTENANCE_DRAINING');
  assert.equal(status.decision.state.reason, 'cli-test');

  run('clear', '--cache', root);
  assert.equal(JSON.parse(run('status', '--cache', root)).decision.ok, true);
});

test('the CLI cutover is a hard stop until it is cleared', async (t) => {
  const root = await tempRoot(t);
  const cli = path.join(__dirname, '..', 'managed', 'admission.cjs');
  execFileSync(process.execPath, [cli, 'cutover', '--cache', root, '--reason', 'swap'], { encoding: 'utf8' });

  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--cache', root], { encoding: 'utf8' }));
  assert.equal(status.decision.code, 'MAINTENANCE_CUTOVER');
  assert.equal(status.decision.state.reason, 'swap');

  execFileSync(process.execPath, [cli, 'clear', '--cache', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'status', '--cache', root], { encoding: 'utf8' })).decision.ok, true);
});
