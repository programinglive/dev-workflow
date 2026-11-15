'use strict';
// Maintenance admission for the ManagedMCP launcher (Issue B).
//
// WHY THIS EXISTS
// ---------------
// A fleet cutover replaces the release every managed client runs. Without a
// gate, a client that starts during the cutover can resolve a half-installed
// release, or pin a revision the operator is about to replace. The launcher is
// the one place every managed client passes through, so the gate lives here.
//
// FAIL CLOSED
// -----------
// An admission file that exists but cannot be read, parsed or understood is
// treated as "maintenance is active", never as "no maintenance". A damaged
// marker means the operator's intent is unknown, and guessing "open" would let
// a launch slip through the exact window the marker was meant to protect.
//
// WHAT THIS CANNOT DO
// -------------------
// It cannot stop an unmodified legacy client that launches `index.js` directly
// without going through `device-entry.cjs` or `launcher.cjs`, and it cannot
// terminate a process that is already running. It only refuses NEW launches.
// Draining therefore means "no new launches; existing sessions finish".
//
// ROLLBACK
// --------
// Remove the file, or set `mode: "open"`. Both restore launches immediately.
// An expired window is NOT treated as open: it reports ADMISSION_STALE so an
// operator clears it deliberately instead of a clock silently reopening the
// fleet.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ADMISSION_FILENAME = 'maintenance-admission.json';
const ADMISSION_SCHEMA_VERSION = 1;
const ADMISSION_MODES = new Set(['open', 'draining', 'cutover']);

/**
 * The managed cache root for this device.
 *
 * Shared so the launcher, the device entry and the admission gate cannot
 * disagree about where the marker lives.
 */
function managedCacheRoot(env = process.env) {
  return (
    env.DEVWF_MANAGED_CACHE ||
    path.join(env.LOCALAPPDATA || path.join(env.HOME || env.USERPROFILE || '.', '.local', 'share'), 'ProgramingLive', 'ManagedMCP')
  );
}

/**
 * Every admission file that applies to this launch.
 *
 * The cache root is the primary location. `DEVWF_MANAGED_ROOTS` lists extra
 * installation roots (separated by the platform path delimiter or a comma), so
 * one machine with several managed installations cannot be half-drained.
 * `DEVWF_MAINTENANCE_ADMISSION` names one explicit file and is used by tests
 * and by an operator who keeps the marker outside the cache.
 *
 * @returns {string[]} absolute paths, de-duplicated, primary first
 */
function admissionPaths({ cacheRoot, env = process.env } = {}) {
  const paths = [];
  const push = (value) => {
    if (!value) return;
    const resolved = path.resolve(String(value));
    if (!paths.includes(resolved)) paths.push(resolved);
  };

  if (cacheRoot) push(path.join(cacheRoot, ADMISSION_FILENAME));

  const explicit = env.DEVWF_MAINTENANCE_ADMISSION;
  if (explicit) push(explicit);

  const extra = env.DEVWF_MANAGED_ROOTS;
  if (extra) {
    for (const entry of String(extra).split(new RegExp(`[${path.delimiter === ';' ? ';' : ':'},]`))) {
      const trimmed = entry.trim();
      if (trimmed) push(path.join(trimmed, ADMISSION_FILENAME));
    }
  }

  return paths;
}

/**
 * Read one admission file and report WHY it produced no state.
 *
 * @returns {{status: "absent"|"ok"|"unreadable", state: object|null, error: string|null}}
 */
function readAdmissionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // ENOENT means "no marker", but only when the path really does not exist.
    // A dangling symlink also reports ENOENT on read while still existing, and
    // treating that as absent would fail open on a marker an operator placed
    // and something else broke.
    if (error && error.code === 'ENOENT' && !pathExists(file)) {
      return { status: 'absent', state: null, error: null };
    }
    return { status: 'unreadable', state: null, error: error?.code || 'ADMISSION_UNREADABLE' };
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', state: null, error: 'ADMISSION_MALFORMED' };
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { status: 'unreadable', state: null, error: 'ADMISSION_INVALID' };
  }
  return { status: 'ok', state, error: null };
}

/**
 * Does anything at all occupy this path?
 *
 * `statSync` follows symlinks, so a dangling link reports ENOENT while the link
 * itself exists. `lstatSync` does not follow, which is what we need to tell
 * "nothing here" from "something here that cannot be resolved".
 */
function pathExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function refusal(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * Decide whether a new managed launch may proceed.
 *
 * @param {object} options
 * @param {string} [options.cacheRoot] managed cache root
 * @param {object} [options.env] environment (for root and override discovery)
 * @param {number} [options.now] clock, injectable for tests
 * @returns {{ok: boolean, code: string, message: string, file?: string, state?: object}}
 */
function evaluateAdmission({ cacheRoot, env = process.env, now = Date.now() } = {}) {
  const files = admissionPaths({ cacheRoot, env });

  for (const file of files) {
    const read = readAdmissionFile(file);
    if (read.status === 'absent') continue;

    if (read.status === 'unreadable') {
      return refusal(
        'ADMISSION_UNREADABLE',
        `Managed launch refused: maintenance admission at ${file} cannot be read (${read.error}). ` +
          'A damaged marker is treated as maintenance, not as permission.',
        { file },
      );
    }

    const state = read.state;
    if (Number(state.schemaVersion) !== ADMISSION_SCHEMA_VERSION) {
      return refusal(
        'ADMISSION_INVALID',
        `Managed launch refused: maintenance admission at ${file} has an unsupported schemaVersion.`,
        { file, state },
      );
    }
    const mode = String(state.mode || '');
    if (!ADMISSION_MODES.has(mode)) {
      return refusal(
        'ADMISSION_INVALID',
        `Managed launch refused: maintenance admission at ${file} has an unknown mode "${mode}".`,
        { file, state },
      );
    }

    if (state.expiresAt !== undefined && state.expiresAt !== null) {
      const expiresAt = Date.parse(state.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        // An expiry that is present but unparseable is a damaged marker. An
        // empty string is falsy, so a truthiness check would silently skip it
        // and admit the launch.
        return refusal(
          'ADMISSION_INVALID',
          `Managed launch refused: maintenance admission at ${file} has an unparseable expiresAt.`,
          { file, state },
        );
      }
      if (expiresAt <= now) {
        return refusal(
          'ADMISSION_STALE',
          `Managed launch refused: the maintenance window at ${file} expired at ${state.expiresAt}. ` +
            'Clear the marker or set mode "open" to reopen launches.',
          { file, state },
        );
      }
    }

    if (mode === 'draining') {
      return refusal(
        'MAINTENANCE_DRAINING',
        `Managed launch refused: maintenance is draining new launches${state.reason ? ` (${state.reason})` : ''}. ` +
          'Existing sessions are left running.',
        { file, state },
      );
    }
    if (mode === 'cutover') {
      // A cutover is a hard stop for every new launch. It is deliberately not
      // "allow the target revision": the device entry cannot prove which
      // revision it is about to run, so any revision-based exception would be
      // unreachable through the configured entry point and would only create a
      // bypass for a caller that can claim a revision. The operator reopens the
      // fleet with `open` or `clear` once the swap is verified.
      return refusal(
        'MAINTENANCE_CUTOVER',
        `Managed launch refused: a cutover is in progress${state.reason ? ` (${state.reason})` : ''}.`,
        { file, state },
      );
    }
  }

  return { ok: true, code: 'ADMISSION_OPEN', message: 'Managed launch admitted.' };
}

/**
 * Throwing form for callers that cannot branch on a return value.
 * The error carries `.code` so the launcher can print a stable reason.
 */
function assertAdmission(options) {
  const decision = evaluateAdmission(options);
  if (decision.ok) return decision;
  const error = new Error(decision.message);
  error.code = decision.code;
  error.admission = decision;
  throw error;
}

/**
 * A stable digest of every admission file that applies to this launch.
 *
 * The launcher reads it before and after release selection. If it changed, a
 * maintenance window opened or closed while the release was being chosen, and
 * the launch is refused rather than racing the cutover.
 */
function admissionFingerprint({ cacheRoot, env = process.env } = {}) {
  const hash = createHash('sha256');
  for (const file of admissionPaths({ cacheRoot, env })) {
    hash.update(file);
    hash.update('\0');
    try {
      const stat = fs.statSync(file);
      hash.update(String(stat.size));
      hash.update('\0');
      hash.update(String(stat.mtimeMs));
      hash.update('\0');
      hash.update(fs.readFileSync(file));
    } catch (error) {
      hash.update(error?.code || 'unreadable');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Write an admission marker atomically.
 *
 * A half-written marker would be unreadable, and unreadable means "refuse", so
 * a crash mid-write would block the fleet. Writing to a temporary file and
 * renaming makes the marker appear complete or not at all.
 */
function writeAdmission({ cacheRoot, env = process.env, state }) {
  const file = admissionPaths({ cacheRoot, env })[0];
  if (!file) throw new Error('No admission path could be resolved');
  const payload = { schemaVersion: ADMISSION_SCHEMA_VERSION, ...state };
  if (!ADMISSION_MODES.has(String(payload.mode || ''))) {
    throw new Error(`Refusing to write an unknown admission mode "${payload.mode}"`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { file, state: payload };
}

/** Remove the marker. Launches resume immediately. */
function clearAdmission({ cacheRoot, env = process.env }) {
  const removed = [];
  for (const file of admissionPaths({ cacheRoot, env })) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { removed };
}

module.exports = {
  ADMISSION_FILENAME,
  ADMISSION_SCHEMA_VERSION,
  ADMISSION_MODES,
  managedCacheRoot,
  admissionPaths,
  readAdmissionFile,
  evaluateAdmission,
  assertAdmission,
  admissionFingerprint,
  writeAdmission,
  clearAdmission,
};

if (require.main === module) {
  // Operator CLI. Everything here is deliberately explicit: an operator must
  // say what the fleet should do, and an expired window is never reopened by
  // the clock.
  const argv = process.argv.slice(2);
  const command = argv[0] || 'status';
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  const cacheRoot = flags.cache || process.env.DEVWF_MANAGED_CACHE || managedCacheRoot(process.env);
  const reason = typeof flags.reason === 'string' ? flags.reason : '';
  const expiresAt = typeof flags.expires === 'string' ? flags.expires : undefined;

  try {
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify({ cacheRoot, decision: evaluateAdmission({ cacheRoot, now: Date.now() }) }, null, 2)}\n`);
    } else if (command === 'drain') {
      writeAdmission({ cacheRoot, state: { mode: 'draining', reason, startedAt: new Date().toISOString(), expiresAt } });
      process.stdout.write(`Managed launches are draining${reason ? ` (${reason})` : ''}.\n`);
    } else if (command === 'cutover') {
      writeAdmission({ cacheRoot, state: { mode: 'cutover', reason, startedAt: new Date().toISOString(), expiresAt } });
      process.stdout.write('Cutover active: new managed launches are refused.\n');
    } else if (command === 'open') {
      writeAdmission({ cacheRoot, state: { mode: 'open', reason, startedAt: new Date().toISOString(), expiresAt } });
      process.stdout.write('Managed launches are open.\n');
    } else if (command === 'clear') {
      const { removed } = clearAdmission({ cacheRoot });
      process.stdout.write(`Cleared ${removed.length} admission marker(s).\n`);
    } else {
      throw new Error(`Unknown command "${command}". Use status|drain|cutover|open|clear.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
