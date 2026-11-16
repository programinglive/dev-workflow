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
    if (Number.isFinite(Number(claim?.generation))) {
      writeGeneration(stateFile, Number(claim.generation));
    }
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
 * The next claim generation for this handover.
 *
 * Derived from the durable audit trail instead of the handover record, because
 * that record is immutable: the `.claim` file is the authoritative winner and a
 * retired claim is kept, never deleted, so the maximum only grows. Returns null
 * when the trail cannot be read, so a caller fails closed instead of silently
 * restarting at generation 1.
 */
function claimGeneration(stateFile) {
  const file = claimPath(stateFile);
  if (!file) return null;
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 1;
    return null;
  }
  let max = 0;
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.retired\\.(\\d+)\\.`);
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  // The live claim counts too: if the retirement trail is cleaned up while a
  // claim remains, the next generation must still move forward.
  const current = readClaim(stateFile);
  if (current && Number.isFinite(Number(current.generation))) {
    max = Math.max(max, Number(current.generation));
  }
  // A durable counter survives cleanup of both the claim and its retired files.
  const durable = readGeneration(stateFile);
  if (Number.isFinite(durable)) max = Math.max(max, durable);
  return max + 1;
}

function generationPath(stateFile) {
  const file = claimPath(stateFile);
  return file ? `${file}.generation` : null;
}

function readGeneration(stateFile) {
  const file = generationPath(stateFile);
  if (!file) return null;
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeGeneration(stateFile, generation) {
  const file = generationPath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  const value = Number(generation);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, code: 'INVALID_GENERATION' };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, String(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: error?.code || 'WRITE_FAILED' };
  }
}

/**
 * Run `fn` while holding the handover's recovery lock.
 *
 * Adoption marking and claim retirement both mutate the same `.claim` path, so
 * they must serialize on the same OS-exclusive lock. Without it, recovery can
 * read an unadopted claim and rename it after adoption has replaced it, which
 * would retire an adopted claim and let a second successor take the task.
 */
function withRecoveryLock(file, fn) {
  const lock = `${file}.recovery`;
  const writeTmp = () => {
    const tmp = `${lock}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    return tmp;
  };
  const tryLink = () => {
    let tmp = null;
    try {
      tmp = writeTmp();
      fs.linkSync(tmp, lock);
      return { ok: true };
    } catch (error) {
      if (error && error.code === 'EEXIST') return { ok: false, code: 'EEXIST' };
      return { ok: false, code: error?.code || 'LINK_FAILED' };
    } finally {
      if (tmp) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  };

  let acquired = tryLink();
  if (!acquired.ok && acquired.code === 'EEXIST') {
    // A recoverer that died while holding the lock must not block recovery
    // forever. The lock records its owner's PID; reclaim it only when that
    // process is provably gone. An unreadable lock is treated as live.
    let ownerPid = null;
    try {
      ownerPid = Number(JSON.parse(fs.readFileSync(lock, 'utf8')).pid);
    } catch {
      ownerPid = null;
    }
    let ownerAlive = true;
    if (Number.isFinite(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (error) {
        ownerAlive = error?.code === 'EPERM';
      }
    }
    if (!ownerAlive) {
      // Rename, not unlink: only one process can move a given path, so two
      // recoverers cannot both reclaim and then unlink each other's live lock.
      const stale = `${lock}.stale.${ownerPid}.${Date.now()}`;
      try {
        fs.renameSync(lock, stale);
        try { fs.unlinkSync(stale); } catch {}
        acquired = tryLink();
      } catch (error) {
        if (error?.code === 'ENOENT') acquired = tryLink();
      }
    }
  }
  if (!acquired.ok) {
    return { ok: false, code: acquired.code === 'EEXIST' ? 'RECOVERY_IN_PROGRESS' : acquired.code };
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

/**
 * Mark a claim as adopted so recovery can never discard a successor's progress.
 *
 * The claim stays in place as the audit record of who won; only the marker is
 * added. Written atomically under the recovery lock so a concurrent retirement
 * cannot rename the claim between the read and the replace.
 */
function markClaimAdopted(stateFile, { sessionKey, at = Date.now() } = {}) {
  const file = claimPath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  return withRecoveryLock(file, () => {
    const current = readClaim(stateFile);
    if (!current) return { ok: false, code: 'NO_CLAIM' };
    if (sessionKey && current.sessionKey !== sessionKey) {
      return { ok: false, code: 'CLAIMANT_MISMATCH' };
    }
    const next = { ...current, adoptedAt: at, adoptedBy: current.sessionKey };
    const tmp = `${file}.${process.pid}.${Date.now()}.adopt.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return { ok: true, claim: next };
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, code: error?.code || 'WRITE_FAILED' };
    }
  });
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
function retireClaim(stateFile, { generation, expectedSessionKey = null, verify = null } = {}) {
  const file = claimPath(stateFile);
  if (!file) return { ok: false, code: 'NO_STATE_FILE' };
  return withRecoveryLock(file, () => {
    const current = readClaim(stateFile);
    if (!current) return { ok: false, code: 'NO_CLAIM' };
    if (Number(current.generation) !== Number(generation)) {
      return { ok: false, code: 'GENERATION_MISMATCH', currentGeneration: current.generation };
    }
    if (expectedSessionKey && current.sessionKey !== expectedSessionKey) {
      return { ok: false, code: 'CLAIMANT_MISMATCH' };
    }
    if (typeof verify === 'function') {
      const verdict = verify(current);
      if (!verdict || verdict.ok !== true) {
        return { ok: false, code: verdict?.code || 'VERIFY_FAILED' };
      }
    }
    const retired = `${file}.retired.${Number(current.generation)}.${Date.now()}`;
    try {
      fs.renameSync(file, retired);
      writeGeneration(stateFile, Number(current.generation));
      return { ok: true, retired, claim: current };
    } catch (error) {
      return { ok: false, code: error?.code || 'RETIRE_FAILED' };
    }
  });
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
  markClaimAdopted,
  retireClaim,
};
