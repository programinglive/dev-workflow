'use strict';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

// MAJOR.MINOR.PATCH with optional prerelease and build metadata, i.e. semver.
// A leading "v" is rejected on purpose: the value is compared across devices, so
// one writer adding "v" would make every other device look out of sync.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function tarExecutable() {
  return process.platform==='win32' ? require('node:path').join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe') : 'tar';
}

/**
 * Validate a managed release manifest.
 *
 * `version` is optional so an older publisher that does not send one still
 * works; when present it must be semver or the manifest is refused. Returning
 * the field is the point: the previous implementation rebuilt the object from
 * three keys and silently dropped everything else, which is why the active
 * version was unreachable without SSH.
 */
function validateManifest(value) {
  if (!value || !/^[a-f0-9]{40}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Invalid managed release manifest');
  }
  if (value.version !== undefined && (typeof value.version !== 'string' || !SEMVER.test(value.version))) {
    throw new Error('Invalid managed release manifest');
  }
  const manifest = {revision:value.revision,sha256:value.sha256,size:value.size};
  if (value.version !== undefined) manifest.version = value.version;
  if (Number.isSafeInteger(value.schemaVersion)) manifest.schemaVersion = value.schemaVersion;
  if (typeof value.releaseId === 'string' && value.releaseId) manifest.releaseId = value.releaseId;
  if (typeof value.artifactDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.artifactDigest)) manifest.artifactDigest = value.artifactDigest;
  if (typeof value.channel === 'string' && value.channel) manifest.channel = value.channel;
  if (typeof value.minimumCompatibleClient === 'string' && value.minimumCompatibleClient) manifest.minimumCompatibleClient = value.minimumCompatibleClient;
  if (typeof value.toolCatalogDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.toolCatalogDigest)) manifest.toolCatalogDigest = value.toolCatalogDigest;
  if (typeof value.rolloutStatus === 'string' && value.rolloutStatus) manifest.rolloutStatus = value.rolloutStatus;
  return manifest;
}

function validateArchiveEntries(listing) {
  const entries = String(listing).split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error('Unsafe empty archive');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
      throw new Error('Unsafe archive path');
    }
  }
}

module.exports={validateManifest,validateArchiveEntries,MAX_ARCHIVE_BYTES,tarExecutable};
