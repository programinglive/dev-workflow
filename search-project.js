import { execFile as execFileCallback } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isProtectedFile } from './security/files.js';
import { secretSpans } from './security/scanner.js';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const MAX_QUERY_CHARS = 500;
export const MAX_CANDIDATE_FILES = 20_000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_RESULTS = 20;
export const MAX_EXCERPT_CHARS = 300;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

const sensitiveDirectoryNames = new Set([
  '.aws', '.azure', '.docker', '.ssh', '.gcloud', 'credential', 'credentials', 'key', 'keys', 'private', 'secret', 'secrets', 'token', 'tokens',
]);
const sensitiveExtensions = new Set(['.cer', '.crt', '.der', '.env', '.jks', '.key', '.p12', '.pfx', '.pem']);
const sensitiveFileName = /(?:^|[._-])(?:credentials?|private[-_]?key|id_rsa|id_ed25519|service[-_]?account|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|token|env)(?:[._-]|$)/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareHits(left, right) {
  return Number(right.exactPhrase) - Number(left.exactPhrase)
    || right.matchedTerms - left.matchedTerms
    || compareText(left.path, right.path)
    || left.line - right.line;
}

function redactContent(text) {
  const spans = secretSpans(text).sort((left, right) => left.start - right.start || right.end - left.end);
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor || span.start < cursor) continue;
    output += text.slice(cursor, span.start);
    output += text.slice(span.start, span.end).replace(/[^\r\n]+/gu, '[REDACTED]');
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

function normalizeForCompare(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function termsFor(query) {
  return [...new Set(normalizeForCompare(query).match(/[\p{L}\p{N}_-]+/gu) || [])];
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSensitivePath(relativePath) {
  const segments = relativePath.split(/[\\/]+/u);
  if (segments.some((segment) => /^\.env(?:\..*)?$/iu.test(segment))) return true;
  if (segments.some((segment) => sensitiveDirectoryNames.has(segment.toLowerCase()))) return true;
  const fileName = segments.at(-1) || '';
  if (['.netrc', '.npmrc', '.pypirc'].includes(fileName.toLowerCase())) return true;
  if (sensitiveFileName.test(fileName)) return true;
  return sensitiveExtensions.has(path.extname(fileName).toLowerCase()) || isProtectedFile(`/${relativePath}`);
}

function excerptFor(line, normalizedLine, terms) {
  let matchAt = -1;
  for (const term of terms) {
    const index = normalizedLine.indexOf(term);
    if (index >= 0 && (matchAt < 0 || index < matchAt)) matchAt = index;
  }

  if (line.length <= MAX_EXCERPT_CHARS) return line;
  const half = Math.floor(MAX_EXCERPT_CHARS / 2);
  const start = Math.max(0, Math.min(line.length - MAX_EXCERPT_CHARS, matchAt - half));
  const end = start + MAX_EXCERPT_CHARS;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
    .slice(0, MAX_EXCERPT_CHARS);
}

function validateQuery(query) {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError('query must not be empty');
  if (trimmed.length > MAX_QUERY_CHARS) throw new RangeError(`query must be at most ${MAX_QUERY_CHARS} characters`);
  return trimmed;
}

function validateLimit(limit) {
  const value = limit === undefined ? 8 : limit;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return value;
}

async function repositoryRoot(projectDir) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw new TypeError('An active project directory is required');
  }

  let pinnedRoot;
  try {
    pinnedRoot = await realpath(projectDir);
  } catch {
    throw new Error('The active project directory is unavailable');
  }

  let gitRootText;
  try {
    ({ stdout: gitRootText } = await execFile('git', ['-C', pinnedRoot, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    }));
  } catch {
    throw new Error('The active project is not an accessible Git repository');
  }

  let gitRoot;
  try {
    gitRoot = await realpath(gitRootText.trim());
  } catch {
    throw new Error('The active Git repository root is unavailable');
  }

  const sameRoot = process.platform === 'win32'
    ? pinnedRoot.toLowerCase() === gitRoot.toLowerCase()
    : pinnedRoot === gitRoot;
  if (!sameRoot) throw new Error('The active project directory must be the Git repository root');
  return gitRoot;
}

async function listCandidatePaths(root) {
  let stdout;
  let ignoredStdout;
  try {
    ({ stdout } = await execFile('git', [
      '-C', root,
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], {
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 10_000,
      encoding: 'utf8',
    }));
    ({ stdout: ignoredStdout } = await execFile('git', [
      '-C', root,
      'ls-files', '--cached', '--ignored', '--exclude-standard', '-z',
    ], {
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 10_000,
      encoding: 'utf8',
    }));
  } catch {
    throw new Error('Could not enumerate files in the active Git repository');
  }
  const ignored = new Set(ignoredStdout.split('\0').filter(Boolean));
  return stdout.split('\0').filter((file) => file && !ignored.has(file)).sort(compareText);
}

function displayPath(relativePath) {
  return relativePath.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/gu, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
function safeRelativePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || /^[a-z]:/iu.test(relativePath)) return false;
  const segments = relativePath.split(/[\\/]+/u);
  return !segments.some((segment) => segment === '..' || segment === '.');
}

export async function readCandidate(root, relativePath, byteBudget, openFile = open) {
  if (!safeRelativePath(relativePath) || isSensitivePath(relativePath)) {
    return { skipped: true };
  }

  const absolutePath = path.resolve(root, relativePath);
  if (!isWithinRoot(root, absolutePath)) return { skipped: true };

  let originalStat;
  let resolvedPath;
  try {
    originalStat = await lstat(absolutePath);
    if (!originalStat.isFile() || originalStat.isSymbolicLink()) return { skipped: true };
    resolvedPath = await realpath(absolutePath);
  } catch {
    return { skipped: true };
  }

  const normalizePath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!isWithinRoot(root, resolvedPath) || normalizePath(resolvedPath) !== normalizePath(absolutePath)) {
    return { skipped: true };
  }
  if (originalStat.size > MAX_FILE_BYTES) return { skipped: true, truncated: true };
  if (originalStat.size > byteBudget) return { skipped: true, truncated: true, stop: true };

  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW || 0;
    handle = await openFile(absolutePath, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    const openedPath = await realpath(absolutePath);
    if (!openedStat.isFile()
      || openedStat.dev !== originalStat.dev
      || openedStat.ino !== originalStat.ino
      || !isWithinRoot(root, openedPath)
      || normalizePath(openedPath) !== normalizePath(absolutePath)) {
      return { skipped: true };
    }
    if (openedStat.size > MAX_FILE_BYTES) return { skipped: true, truncated: true };
    if (openedStat.size > byteBudget) return { skipped: true, truncated: true, stop: true };

    const readLimit = Math.min(MAX_FILE_BYTES, byteBudget);
    const buffer = Buffer.alloc(readLimit);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const finalStat = await handle.stat();
    if (bytesRead > MAX_FILE_BYTES || finalStat.size > MAX_FILE_BYTES) {
      return { skipped: true, bytesRead: Math.min(bytesRead, readLimit), truncated: true };
    }
    if (bytesRead > byteBudget || finalStat.size > byteBudget) {
      return { skipped: true, bytesRead: Math.min(bytesRead, byteBudget), truncated: true, stop: true };
    }

    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return { skipped: true, bytesRead };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), bytesRead };
    } catch {
      return { skipped: true, bytesRead };
    }
  } catch {
    return { skipped: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Search bounded textual files in exactly one pinned Git repository. */
export async function searchProject({ projectDir, query, limit } = {}) {
  const cleanQuery = validateQuery(query);
  const resultLimit = validateLimit(limit);
  const root = await repositoryRoot(projectDir);
  const candidatePaths = await listCandidatePaths(root);
  const truncatedByCandidateCap = candidatePaths.length > MAX_CANDIDATE_FILES;
  const boundedPaths = candidatePaths.slice(0, MAX_CANDIDATE_FILES);
  const normalizedQuery = normalizeForCompare(cleanQuery);
  const terms = termsFor(cleanQuery);
  const hits = [];
  let skipped = 0;
  let totalBytesRead = 0;
  let truncated = truncatedByCandidateCap;

  for (const relativePath of boundedPaths) {
    const remainingBytes = MAX_TOTAL_BYTES - totalBytesRead;
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }

    const candidate = await readCandidate(root, relativePath, remainingBytes);
    if (candidate.skipped) skipped += 1;
    if (candidate.bytesRead) totalBytesRead += candidate.bytesRead;
    if (candidate.truncated) truncated = true;
    if (candidate.stop) break;
    if (!candidate.text) continue;

    const lines = redactContent(candidate.text).split(/\r\n|\n|\r/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const normalizedLine = normalizeForCompare(line);
      const exactPhrase = normalizedLine.includes(normalizedQuery);
      const matchedTerms = terms.reduce((count, term) => count + (normalizedLine.includes(term) ? 1 : 0), 0);
      if (!exactPhrase && matchedTerms === 0) continue;
      const hit = {
        path: displayPath(relativePath),
        line: index + 1,
        text: excerptFor(line, normalizedLine, terms).replace(/[\u0000-\u001f\u007f]/gu, ' '),
        exactPhrase,
        matchedTerms,
      };
      hits.push(hit);
      hits.sort(compareHits);
      if (hits.length > resultLimit) {
        hits.pop();
        truncated = true;
      }
    }
  }

  if (hits.length > resultLimit) truncated = true;
  return {
    hits: hits.slice(0, resultLimit).map(({ path: filePath, line, text }) => ({ path: filePath, line, text })),
    skipped,
    truncated,
    scanned: boundedPaths.length,
    bytesRead: totalBytesRead,
  };
}







