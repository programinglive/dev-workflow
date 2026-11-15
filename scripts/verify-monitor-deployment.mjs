#!/usr/bin/env node
/**
 * Read-only verification of a deployed DevWorkflow Monitor.
 *
 * This is the executable half of `docs/operations/monitor-deployment.md`. It
 * never writes, never restarts, and never migrates: it answers "is the deployed
 * thing the thing we built, and is it safe?" so an operator can decide.
 *
 * CHECKS
 * ------
 * 1. `/health` answers 200.
 * 2. Every module the deployed entrypoint requires is present in the deploy
 *    directory (the dependency closure is derived from the source, not a
 *    hand-written list that drifts).
 * 3. The environment file parses safely and carries a reaper credential.
 * 4. The privileged endpoint refuses an unsigned request and accepts a signed
 *    one for an authorized machine.
 * 5. The public `/api/sessions` payload exposes no owner or lease field.
 * 6. With `--db`, migration 005 columns exist.
 *
 * USAGE
 * -----
 *   node scripts/verify-monitor-deployment.mjs \
 *     --base-url http://monitor-host.example:3100 \
 *     --dir /opt/devwf-monitor \
 *     --env-file /etc/devwf-monitor.env \
 *     --machine MMCH \
 *     --db "$DATABASE_URL"
 *
 * Exit code 0 means every check passed. Any failure prints the exact check and
 * exits 1.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseEnvFile } from './env-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRIVILEGED_FIELDS = [
  'owner_pid',
  'owner_started_at',
  'owner_executable',
  'lease_owner',
  'lease_generation',
  'lease_fencing_token',
];

const MIGRATION_COLUMNS = [
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

/**
 * Collect the local `require('./x.cjs')` targets of a CommonJS file.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function localRequires(source) {
  const found = new Set();
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(String(source))) !== null) found.add(match[1]);
  return [...found];
}

/**
 * Resolve the dependency closure of an entrypoint inside a directory.
 *
 * @returns {Promise<{missing: string[], checked: string[]}>}
 */
export async function dependencyClosure({ entry, dir }) {
  const missing = [];
  const checked = [];
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    checked.push(relative);

    let source;
    try {
      source = await fs.readFile(path.join(dir, relative), 'utf8');
    } catch {
      missing.push(relative);
      continue;
    }
    for (const target of localRequires(source)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  return { missing, checked };
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

async function checkHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
  if (response.status !== 200) throw new Error(`/health returned HTTP ${response.status}`);
  return 'ok';
}

async function checkPrivileged({ baseUrl, machine, secret }) {
  const unsigned = await fetch(`${baseUrl}/api/reaper/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list', at: new Date().toISOString(), machine }),
    signal: AbortSignal.timeout(8000),
  });
  if (unsigned.status !== 401) {
    throw new Error(`unsigned privileged request returned HTTP ${unsigned.status}, expected 401`);
  }

  const payload = { action: 'list', at: new Date().toISOString(), machine };
  const signed = await fetch(`${baseUrl}/api/reaper/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-devwf-reaper-signature': sign(payload, secret),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (signed.status !== 200) {
    const body = await signed.text().catch(() => '');
    throw new Error(`signed privileged request returned HTTP ${signed.status}: ${body.slice(0, 200)}`);
  }
  const data = await signed.json();
  if (!Array.isArray(data.sessions)) throw new Error('privileged response has no sessions array');
  return `${data.sessions.length} session(s)`;
}

async function checkPublicPayload(baseUrl) {
  const response = await fetch(`${baseUrl}/api/sessions?limit=5`, { signal: AbortSignal.timeout(8000) });
  if (response.status !== 200) throw new Error(`/api/sessions returned HTTP ${response.status}`);
  const text = await response.text();
  for (const field of PRIVILEGED_FIELDS) {
    if (text.includes(field)) throw new Error(`public payload exposes ${field}`);
  }
  return 'no privileged field';
}

async function checkMigration(connectionString) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = ANY($1::text[])`,
      [MIGRATION_COLUMNS],
    );
    const present = new Set(rows.map((row) => row.column_name));
    const missing = MIGRATION_COLUMNS.filter((column) => !present.has(column));
    if (missing.length > 0) throw new Error(`migration 005 not applied: missing ${missing.join(', ')}`);
    return `${MIGRATION_COLUMNS.length} column(s)`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv) {
  const baseUrl = arg(argv, 'base-url', 'http://127.0.0.1:3100').replace(/\/$/, '');
  const dir = arg(argv, 'dir', '/opt/devwf-monitor');
  const envFile = arg(argv, 'env-file', '/etc/devwf-monitor.env');
  const machine = arg(argv, 'machine', '');
  const db = arg(argv, 'db', '');
  const allowMutation = argv.includes('--allow-mutation');

  const results = [];
  const fail = (name, error) => {
    results.push({ name, ok: false, detail: String(error?.message || error) });
  };
  const pass = (name, detail) => results.push({ name, ok: true, detail });

  try {
    pass('health', await checkHealth(baseUrl));
  } catch (error) {
    fail('health', error);
  }

  try {
    const closure = await dependencyClosure({ entry: 'monitor.cjs', dir });
    if (closure.missing.length > 0) {
      throw new Error(`missing module(s): ${closure.missing.join(', ')}`);
    }
    pass('dependency closure', `${closure.checked.length} module(s)`);
  } catch (error) {
    fail('dependency closure', error);
  }

  let env = {};
  try {
    env = parseEnvFile(await fs.readFile(envFile, 'utf8'));
    const hasSecret = Boolean(env.DEVWF_REAPER_SECRET || env.DEVWF_REAPER_SECRETS);
    if (!hasSecret) throw new Error('no DEVWF_REAPER_SECRET or DEVWF_REAPER_SECRETS');
    if (!allowMutation && env.DEVWF_REAPER_DRY_RUN === '0') {
      throw new Error('DEVWF_REAPER_DRY_RUN=0 before the canary was verified');
    }
    pass('environment', `parsed ${Object.keys(env).length} key(s), reaper credential present`);
  } catch (error) {
    fail('environment', error);
  }

  if (machine && (env.DEVWF_REAPER_SECRETS || env.DEVWF_REAPER_SECRET)) {
    let secret = env.DEVWF_REAPER_SECRET || '';
    if (env.DEVWF_REAPER_SECRETS) {
      try {
        const map = JSON.parse(env.DEVWF_REAPER_SECRETS);
        secret = String(map[machine] || '');
      } catch {
        secret = '';
      }
    }
    if (!secret) {
      fail('privileged api', `no credential for machine ${machine}`);
    } else {
      try {
        pass('privileged api', await checkPrivileged({ baseUrl, machine, secret }));
      } catch (error) {
        fail('privileged api', error);
      }
    }
  } else {
    fail('privileged api', 'pass --machine and a reaper credential to verify');
  }

  try {
    pass('public payload', await checkPublicPayload(baseUrl));
  } catch (error) {
    fail('public payload', error);
  }

  if (db) {
    try {
      pass('migration 005', await checkMigration(db));
    } catch (error) {
      fail('migration 005', error);
    }
  } else {
    results.push({ name: 'migration 005', ok: true, detail: 'skipped (no --db)' });
  }

  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} check(s) passed.\n`);
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
