'use strict';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
function tarExecutable() {
  return process.platform==='win32' ? require('node:path').join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe') : 'tar';
}
function validateManifest(value) {
  if (!value || !/^[a-f0-9]{40}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Invalid managed release manifest');
  }
  return {revision:value.revision,sha256:value.sha256,size:value.size};
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
