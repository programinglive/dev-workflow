'use strict';

/**
 * Which release the fleet is supposed to be on.
 *
 * WHY THIS IS NOT A MAJORITY VOTE
 * -------------------------------
 * The fleet panel used to derive its "target" from whatever most machines last
 * reported. On 16 November 2026 that produced target 1.31.0 while the approved
 * release was 1.32.1: two machines had not restarted since the release and
 * outvoted the one that had, so the screen recommended the stale version and
 * flagged the correct machine as the odd one out.
 *
 * The approved release already exists as a file the release host writes when a
 * release is promoted (`/var/lib/devwf-releases/current.json`). That file is the
 * source of truth, and only `stable` counts: a canary or draft must never
 * become the number every machine is measured against.
 *
 * Fail-soft on purpose: an unreadable file returns null so the caller can fall
 * back to the reported majority and say so, instead of inventing a target.
 */

const fs = require('node:fs');

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

// The monitor asks for the target on every page render; re-reading the file is
// cheap but re-parsing it is not, and the mtime is the only thing that can
// change here.
const cache = new Map();

function readJsonFile(target, parse) {
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    const hit = cache.get(target);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;

    const value = parse(JSON.parse(fs.readFileSync(target, 'utf8')));
    cache.set(target, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

function parseApprovedRelease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const revision = typeof raw.revision === 'string' ? raw.revision.trim() : '';
  const channel = raw.channel === undefined || raw.channel === null ? 'stable' : String(raw.channel);

  if (!VERSION_PATTERN.test(version)) return null;
  if (!REVISION_PATTERN.test(revision)) return null;
  if (channel !== 'stable') return null;

  return { version, revision };
}

/**
 * The pinned toolchain, read from the same kind of file as the approved release.
 *
 * A manifest without a tool map is rejected: an empty pins object would make
 * every machine look correct, which is the opposite of a parity check.
 */
function parseFleetManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!raw.tools || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) return null;
  return raw;
}

function loadApprovedRelease({ file, env = process.env } = {}) {
  return readJsonFile(file || env.DEVWF_APPROVED_RELEASE_FILE || '', parseApprovedRelease);
}

function loadFleetManifestSnapshot({ file, env = process.env } = {}) {
  return readJsonFile(file || env.DEVWF_TOOLCHAIN_MANIFEST || '', parseFleetManifest);
}

module.exports = { loadApprovedRelease, parseApprovedRelease, loadFleetManifestSnapshot, parseFleetManifest };
