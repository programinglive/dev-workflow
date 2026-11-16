'use strict';
// Durable store for the cooperative restart handshake.
//
// WHY IT IS SEPARATE FROM WORKFLOW STATE
// --------------------------------------
// The session's workflow state is loaded from SQLite, not from the JSON file
// beside it, and once the mutex is released the normal save path correctly
// refuses. A record written through `workflowState.save()` therefore cannot
// survive the release, and a record written into the JSON file is not what the
// next request reads. The handshake needs its own durable record that is not
// part of unrestricted workflow mutation: one small file per session, written
// atomically, read by anyone who knows the session's state file.
const fs = require('node:fs');
const path = require('node:path');

const SUFFIX = '.restart-handshake.json';

// Accept either the session state file or the sidecar path itself, so a
// controller holding a handover path does not have to know the convention.
function handshakePath(stateFile) {
  if (!stateFile) return null;
  const resolved = path.resolve(String(stateFile));
  return resolved.endsWith(SUFFIX) ? resolved : `${resolved}${SUFFIX}`;
}

/**
 * Read the handshake record. A missing file is "no handshake", not a failure,
 * but a file that exists and cannot be parsed is a corrupted record and is
 * reported as such rather than silently treated as absent.
 */
function readHandshake(stateFile) {
  const file = handshakePath(stateFile);
  if (!file) return { status: 'absent', record: null, file: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'absent', record: null, file };
    return { status: 'unreadable', record: null, file, error: error?.code || 'READ_FAILED' };
  }
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || !record.state) {
      return { status: 'corrupt', record: null, file, error: 'MISSING_STATE' };
    }
    return { status: 'ok', record, file };
  } catch {
    return { status: 'corrupt', record: null, file, error: 'MALFORMED_JSON' };
  }
}

/**
 * Write the record atomically: a crash mid-write leaves the previous record
 * intact instead of a truncated one.
 */
function writeHandshake(stateFile, record) {
  const file = handshakePath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: error?.code || 'WRITE_FAILED', file };
  }
}

function clearHandshake(stateFile) {
  const file = handshakePath(stateFile);
  if (!file) return { ok: true, removed: false };
  try {
    fs.unlinkSync(file);
    return { ok: true, removed: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, code: error?.code || 'UNLINK_FAILED' };
  }
}

/**
 * Claim a handover with true cross-process single-winner semantics.
 *
 * A read followed by an atomic rename is NOT a compare-and-swap: two processes
 * can both read "unclaimed" and both rename, and the second silently wins.
 * `link(2)` is the primitive the OS guarantees exactly one creator for: the
 * loser gets EEXIST and no claim file exists for it.
 *
 * The claim lives in its own file (`.claim`) next to the handover, so the
 * handover record itself is never rewritten by the race.
 */
function claimPath(stateFile) {
  if (!stateFile) return null;
  const resolved = path.resolve(String(stateFile));
  return resolved.endsWith(SUFFIX) ? `${resolved}.claim` : `${resolved}${SUFFIX}.claim`;
}

function readClaim(stateFile) {
  const file = claimPath(stateFile);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tryClaimHandshake(stateFile, claim) {
  const file = claimPath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(claim, null, 2), { mode: 0o600 });
  } catch (error) {
    return { ok: false, code: error?.code || 'WRITE_FAILED' };
  }
  try {
    // link(2) fails with EEXIST when another process already created the claim.
    fs.linkSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return { ok: false, code: 'ALREADY_CLAIMED', file };
    }
    return { ok: false, code: error?.code || 'LINK_FAILED' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * How many claims have already been retired for this handover.
 *
 * The generation is derived from the durable audit trail instead of being
 * written into the handover record, because that record is immutable: the
 * `.claim` file is the authoritative winner and a retired claim is kept, never
 * deleted, so the count only grows.
 */
function retiredClaimCount(stateFile) {
  const file = claimPath(stateFile);
  if (!file) return 0;
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.retired.`)).length;
  } catch {
    return 0;
  }
}

function claimGeneration(stateFile) {
  return retiredClaimCount(stateFile) + 1;
}

/**
 * Retire a stale claim so a crashed successor cannot strand the task forever.
 *
 * This is the only path that removes a `.claim`, and it is deliberately narrow:
 * the caller must present the exact generation it observed, the claimant must
 * be proven dead by the controller, and the retirement is serialized by an
 * OS-exclusive lock so two recoverers cannot both act. The retired claim is
 * renamed, not deleted, so the audit trail survives.
 */
function retireClaim(stateFile, { generation, expectedSessionKey = null } = {}) {
  const file = claimPath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  const lock = `${file}.recovery`;
  const tmp = `${lock}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  } catch (error) {
    return { ok: false, code: error?.code || 'WRITE_FAILED' };
  }
  try {
    fs.linkSync(tmp, lock);
  } catch (error) {
    if (error && error.code === 'EEXIST') return { ok: false, code: 'RECOVERY_IN_PROGRESS' };
    return { ok: false, code: error?.code || 'LINK_FAILED' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  try {
    const current = readClaim(stateFile);
    if (!current) return { ok: false, code: 'NO_CLAIM' };
    if (Number(current.generation) !== Number(generation)) {
      return { ok: false, code: 'GENERATION_MISMATCH', currentGeneration: current.generation };
    }
    if (expectedSessionKey && current.sessionKey !== expectedSessionKey) {
      return { ok: false, code: 'CLAIMANT_MISMATCH' };
    }
    const retired = `${file}.retired.${Number(current.generation)}.${Date.now()}`;
    fs.renameSync(file, retired);
    return { ok: true, retired, claim: current };
  } catch (error) {
    return { ok: false, code: error?.code || 'RETIRE_FAILED' };
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

module.exports = {
  SUFFIX,
  handshakePath,
  claimPath,
  readHandshake,
  writeHandshake,
  clearHandshake,
  readClaim,
  tryClaimHandshake,
  claimGeneration,
  retireClaim,
};
