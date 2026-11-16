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

function handshakePath(stateFile) {
  if (!stateFile) return null;
  return `${path.resolve(String(stateFile))}${SUFFIX}`;
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

module.exports = { SUFFIX, handshakePath, readHandshake, writeHandshake, clearHandshake };
