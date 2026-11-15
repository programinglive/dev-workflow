#!/usr/bin/env node
/**
 * Read-only canary for the controller-to-monitor attestation path.
 *
 * Runs against a live monitor and a real database, but it only touches rows it
 * created itself: a fixture session bound to a fixture process that it starts
 * and then kills. It never touches a real session, never stops a real process,
 * and never archives anything.
 *
 * WHAT IT PROVES
 * --------------
 * 1. A signed attestation for a confirmed-absent fixture is accepted (202).
 * 2. The same attestation replayed is refused (409 ATTESTATION_REPLAYED).
 * 3. Another machine's credential is refused (401).
 * 4. An unsigned request is refused (401).
 * 5. A live process produces no attestation from the controller.
 * 6. The public session payload carries no privileged field.
 *
 * USAGE
 * -----
 *   node scripts/reaper-attestation-canary.mjs \
 *     --base-url http://127.0.0.1:3100 \
 *     --db "$DATABASE_URL" \
 *     --machine MMCH \
 *     --secret-file /path/to/machine-secret
 *
 * Exit code 0 means every check passed.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalAdapters } from '../session-controller-adapters.js';
import { verifyProcessIdentity } from '../session-reaper.js';
import { attestOrphan } from '../reaper-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PRIVILEGED_FIELDS = [
  'owner_pid',
  'owner_started_at',
  'owner_executable',
  'lease_owner',
  'lease_generation',
  'lease_fencing_token',
];

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start a fixture process and return its verified identity.
 *
 * The fixture is a private child of this script, so it can never be a real
 * agent session.
 */
async function startFixture(adapters) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = adapters.processInfo(child.pid);
    if (info) return { child, info };
    await sleep(100);
  }
  throw new Error('fixture process did not become inspectable');
}

async function stopFixture(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const baseUrl = arg(argv, 'base-url', 'http://127.0.0.1:3100').replace(/\/$/, '');
  const db = arg(argv, 'db', '');
  const machine = arg(argv, 'machine', '');
  const secretFile = arg(argv, 'secret-file', '');

  if (!db || !machine || !secretFile) {
    process.stderr.write('usage: --db <url> --machine <name> --secret-file <path> [--base-url <url>]\n');
    process.exitCode = 2;
    return;
  }

  const secret = (await fs.readFile(secretFile, 'utf8')).trim();
  if (!secret) throw new Error('secret file is empty');

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: db, connectionTimeoutMillis: 8000 });
  await client.connect();

  const adapters = createLocalAdapters();
  const sessionKey = `ses_canary_${Date.now()}`;
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });

  let fixture = null;
  try {
    fixture = await startFixture(adapters);

    // A fixture row that looks exactly like a real session, bound to the fixture
    // process. It is removed in the finally block.
    await client.query(
      `INSERT INTO sessions
         (session_key, task_id, machine, project_name, phase, owner_pid,
          owner_started_at, owner_executable, lease_owner, lease_generation,
          lease_fencing_token, updated_at)
       VALUES ($1, 'canary', $2, 'reaper-canary', 'coding', $3, $4, $5, 'canary-owner', 1, 'canary-fence', now())`,
      [sessionKey, machine, fixture.info.pid, fixture.info.startedAt, fixture.info.executable],
    );

    const session = {
      session_key: sessionKey,
      machine,
      project_name: 'reaper-canary',
      updated_at: new Date().toISOString(),
      owner: { pid: fixture.info.pid, startedAt: fixture.info.startedAt, executable: fixture.info.executable },
    };

    // 5. A live process must not be attested by the controller.
    const liveIdentity = verifyProcessIdentity(session, adapters);
    record('live process is not attested', liveIdentity.ok === true, liveIdentity.ok ? 'alive' : liveIdentity.code);

    // Kill the fixture so the process is genuinely absent.
    await stopFixture(fixture.child);
    fixture = null;

    const deadIdentity = verifyProcessIdentity(session, adapters);
    record('absent process is detected', deadIdentity.code === 'PROCESS_ABSENT', deadIdentity.code || 'ok');

    const attestation = {
      sessionKey,
      projectName: 'reaper-canary',
      pid: session.owner.pid,
      startedAt: session.owner.startedAt,
      executable: session.owner.executable,
      leaseOwner: 'canary-owner',
      leaseGeneration: 1,
      leaseFencingToken: 'canary-fence',
      verifiedAt: new Date().toISOString(),
      nonce: randomUUID(),
    };

    // 1. A valid attestation is accepted.
    const accepted = await attestOrphan({ baseUrl, secret, machine, attestation });
    record('valid attestation accepted', accepted.ok === true, `status=${accepted.status}`);

    // 2. The same nonce replayed is refused.
    const replayed = await attestOrphan({ baseUrl, secret, machine, attestation });
    record('replayed attestation refused', replayed.ok === false && replayed.error === 'ATTESTATION_REPLAYED', replayed.error || 'accepted');

    // 3. Another machine's credential is refused.
    const forged = await attestOrphan({
      baseUrl,
      secret: `${secret}-wrong`,
      machine,
      attestation: { ...attestation, nonce: randomUUID() },
    });
    record('wrong credential refused', forged.ok === false, forged.error || 'accepted');

    // 4. An unsigned request is refused.
    const unsigned = await fetch(`${baseUrl}/api/reaper/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attest', at: new Date().toISOString(), machine }),
    });
    record('unsigned request refused', unsigned.status === 401, `status=${unsigned.status}`);

    // 6. The public payload carries no privileged field.
    const publicResponse = await fetch(`${baseUrl}/api/sessions?limit=5`);
    const publicText = await publicResponse.text();
    const leaked = PRIVILEGED_FIELDS.filter((field) => publicText.includes(field));
    record('public payload has no privileged field', leaked.length === 0, leaked.join(',') || 'clean');
  } finally {
    if (fixture) await stopFixture(fixture.child);
    await client.query('DELETE FROM reaper_attestations WHERE session_key = $1', [sessionKey]).catch(() => {});
    await client.query('DELETE FROM sessions WHERE session_key = $1', [sessionKey]).catch(() => {});
    await client.end().catch(() => {});
  }

  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} check(s) passed.\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`canary failed: ${String(error && error.message || error)}\n`);
  process.exitCode = 1;
});
