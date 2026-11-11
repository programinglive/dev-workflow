'use strict';

/**
 * Shared Live Build Monitor helpers for both the dev-workflow MCP server and
 * the standalone monitor-server dashboard (dashboard.cjs).
 */

const VALID_BUILD_STATUSES = new Set([
  'building',
  'testing',
  'scanning',
  'deploying',
  'succeeded',
  'failed',
  'idle',
]);

function cleanStr(val, maxLen = 400) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function validateJobUrl(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (!str) return '';
  try {
    const u = new URL(str);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch {}
  return '';
}

function extractHostFromCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return '';
  const cleanCmd = cmd.trim();

  const gcloudMatch = cleanCmd.match(/gcloud\s+compute\s+ssh\s+([a-zA-Z0-9_.-]+)/i);
  if (gcloudMatch && gcloudMatch[1]) {
    return gcloudMatch[1];
  }

  const sshIdx = cleanCmd.search(/(?:^|\s)ssh(?:\.exe)?\s+/i);
  if (sshIdx !== -1) {
    const afterSsh = cleanCmd.slice(sshIdx).replace(/^(?:\s*)ssh(?:\.exe)?\s+/i, '');
    const tokens = afterSsh.split(/\s+/);
    let skipNext = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (tok.startsWith('-')) {
        if (['-o', '-p', '-i', '-l', '-F', '-c'].includes(tok)) {
          skipNext = true;
        }
        continue;
      }
      const host = tok.split('@').pop().split(':')[0];
      if (host && /^[a-zA-Z0-9_.-]+$/.test(host)) {
        return host;
      }
      break;
    }
  }

  return '';
}

/**
 * Normalize and merge a build status update with any previous activeBuild state.
 *
 * @param {object} input
 * @param {object|null} [existing]
 */
function normalizeBuildState(input = {}, existing = null) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const rawStatus = cleanStr(input.status || prev.status || 'building', 32).toLowerCase();
  const status = VALID_BUILD_STATUSES.has(rawStatus) ? rawStatus : 'building';

  const nowIso = new Date().toISOString();
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'idle';
  const wasActive =
    prev.status &&
    prev.status !== 'succeeded' &&
    prev.status !== 'failed' &&
    prev.status !== 'idle' &&
    prev.startedAt;

  const target = cleanStr(
    input.target !== undefined ? input.target : prev.target || input.command || 'project build',
    200,
  );
  const sameRunningBuild = prev.target === target &&
    !['succeeded', 'failed', 'idle'].includes(prev.status) &&
    (prev.status === status || ['succeeded', 'failed', 'idle'].includes(status));
  const command = cleanStr(
    input.command !== undefined ? input.command : prev.command || '',
    300,
  );
  let resolvedBuildHost = cleanStr(
    input.buildHost !== undefined ? input.buildHost : sameRunningBuild ? prev.buildHost : '',
    120,
  );
  if (!resolvedBuildHost && command) {
    resolvedBuildHost = extractHostFromCommand(command);
  }
  if (!resolvedBuildHost && typeof input.machine === 'string' && input.machine.trim()) {
    resolvedBuildHost = cleanStr(input.machine, 120);
  }
  const buildHost = resolvedBuildHost;
  const stage = cleanStr(
    input.stage !== undefined ? input.stage : prev.stage || '',
    240,
  );
  const output = cleanStr(
    input.output !== undefined ? input.output : prev.output || '',
    600,
  );

  /*
   * Per-test-case visibility.
   *
   * OWNER REQUEST (10 November 2026): "I want output about test cases on the
   * monitor, so we know tests are running and how far they have got." A card
   * that only says `npm test (100%)` cannot distinguish a slow suite from a
   * frozen one.
   *
   * WHY BOUNDED AND WHY AN EMPTY LIST CLEARS
   * ----------------------------------------
   * The payload travels through the session row on every report, so an
   * unbounded suite (thousands of cases) would bloat every write and every
   * dashboard poll. Only the last MAX_TEST_CASES are kept, and each name is
   * truncated. An EXPLICIT empty array means "this build has no cases now"
   * and must clear the old list; an ABSENT array means "no news" and keeps
   * what is already known.
   */
  const testCases =
    input.testCases !== undefined
      ? normalizeTestCases(input.testCases)
      : Array.isArray(prev.testCases)
        ? prev.testCases
        : [];

  let progress = null;
  if (input.progress !== undefined && input.progress !== null && input.progress !== '') {
    const n = Number(input.progress);
    if (Number.isFinite(n)) {
      progress = Math.max(0, Math.min(100, Math.round(n)));
    }
  } else if (status === 'succeeded') {
    progress = 100;
  } else if (Number.isFinite(prev.progress)) {
    progress = prev.progress;
  }
  // No explicit percentage: derive one from the cases so the bar moves while a
  // suite runs. Only cases that have settled count as done.
  if (progress === null && testCases.length > 0) {
    progress = Math.max(0, Math.min(100, Math.round((settledTestCases(testCases) / testCases.length) * 100)));
  }

  const startedAt = cleanStr(
    input.startedAt || (wasActive ? prev.startedAt : nowIso),
    64,
  );
  const updatedAt = cleanStr(input.updatedAt || nowIso, 64);
  const finishedAt = isTerminal ? cleanStr(input.finishedAt || nowIso, 64) : '';

  const isSameBuild = !input.target || input.target === prev.target;
  const rawJobUrl = input.jobUrl !== undefined
    ? input.jobUrl
    : input.url !== undefined
      ? input.url
      : input.buildUrl !== undefined
        ? input.buildUrl
        : isSameBuild
          ? prev.jobUrl
          : '';
  let jobUrl = validateJobUrl(rawJobUrl);
  if (!jobUrl) {
    const envUrl = (typeof process !== 'undefined' && process.env)
      ? (process.env.CI_JOB_URL || process.env.BUILD_URL || '')
      : '';
    jobUrl = validateJobUrl(envUrl);
  }

  return {
    status,
    target,
    buildHost,
    command,
    stage,
    progress,
    output,
    testCases,
    jobUrl,
    startedAt,
    updatedAt,
    finishedAt,
  };
}

/**
 * The case statuses a card knows how to draw.
 *
 * Anything else becomes `unknown` rather than being coerced into `passed` or
 * `failed`: a monitor that invents a result is worse than one that admits it
 * does not understand the report.
 */
const TEST_CASE_STATUSES = new Set(['passed', 'failed', 'skipped', 'running', 'unknown']);

/** Keep the most recent cases; a suite is read from the bottom up. */
const MAX_TEST_CASES = 100;

function normalizeTestCases(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .slice(-MAX_TEST_CASES)
    .map((entry) => {
      const name = cleanStr(entry.name || entry.title || '', 160);
      const status = String(entry.status || '').trim().toLowerCase();
      const durationMs = Number(entry.durationMs !== undefined ? entry.durationMs : entry.ms);
      return {
        name,
        status: TEST_CASE_STATUSES.has(status) ? status : 'unknown',
        durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
      };
    })
    .filter((entry) => entry.name !== '');
}

/** Cases that have settled (anything except still-running). */
function settledTestCases(testCases) {
  return (Array.isArray(testCases) ? testCases : []).filter(
    (entry) => entry && entry.status !== 'running'
  ).length;
}

/**
 * Counts for the card header.
 *
 * Returns zeroes rather than null for an empty list so the template never has
 * to branch on undefined.
 */
function summarizeTestCases(testCases) {
  const list = Array.isArray(testCases) ? testCases : [];
  const summary = { total: list.length, passed: 0, failed: 0, skipped: 0, running: 0, unknown: 0 };
  for (const entry of list) {
    const status = entry && TEST_CASE_STATUSES.has(entry.status) ? entry.status : 'unknown';
    summary[status] += 1;
  }
  return summary;
}

function renderAsciiBar(progress, width = 16) {
  if (!Number.isFinite(progress)) {
    return '[▓▓▓▓░░░░░░░░░░░░] (running)';
  }
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((pct / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

function formatElapsedShort(startedAt, finishedAt) {
  if (!startedAt) return '';
  const startMs = new Date(startedAt).getTime();
  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
  const totalSec = Math.round((endMs - startMs) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
}

function statusBadge(status) {
  switch (String(status || '').toLowerCase()) {
    case 'building':
      return '🔨 BUILDING';
    case 'testing':
      return '🧪 TESTING';
    case 'scanning':
      return '🛡️ SCANNING';
    case 'deploying':
      return '🚀 DEPLOYING';
    case 'succeeded':
      return '✅ BUILD SUCCEEDED';
    case 'failed':
      return '❌ BUILD FAILED';
    default:
      return '⏸️ IDLE';
  }
}

/**
 * Render a concise markdown section for MCP responses (`get_workflow_status`,
 * `continue_workflow`, `report_build_status`).
 */
function formatBuildStatusBlock(activeBuild, buildHistory = []) {
  if (!activeBuild || typeof activeBuild !== 'object' || !activeBuild.target) {
    return '';
  }

  const elapsed = formatElapsedShort(activeBuild.startedAt, activeBuild.finishedAt);
  const lines = [
    '🏗️ Active Build / Execution Monitor:',
    `- **Status**: ${statusBadge(activeBuild.status)}${elapsed ? ` (⏱ ${elapsed})` : ''}`,
    `- **Target**: \`${activeBuild.target}\``,
  ];
  if (activeBuild.buildHost) lines.push(`- **Build host**: ${activeBuild.buildHost}`);
  if (activeBuild.jobUrl) lines.push(`- **Runner / Job URL**: ${activeBuild.jobUrl}`);

  if (activeBuild.stage) {
    lines.push(`- **Current Stage**: ${activeBuild.stage}`);
  }
  if (activeBuild.command) {
    lines.push(`- **Command**: \`${activeBuild.command}\``);
  }
  lines.push(`- **Progress**: ${renderAsciiBar(activeBuild.progress)}`);

  if (activeBuild.output) {
    lines.push(`- **Latest Output**: \`${activeBuild.output.replace(/\r?\n/g, ' | ').slice(0, 220)}\``);
  }

  // Test case progress, so the agent's own answer also shows how far a suite
  // has got instead of only a percentage.
  if (Array.isArray(activeBuild.testCases) && activeBuild.testCases.length > 0) {
    const counts = summarizeTestCases(activeBuild.testCases);
    const running = activeBuild.testCases.filter((entry) => entry && entry.status === 'running');
    lines.push(
      `- **Test Cases**: ${counts.passed} passed, ${counts.failed} failed, ` +
        `${counts.skipped} skipped, ${counts.running} running (${counts.total} reported)`
    );
    if (running.length > 0) {
      lines.push(`- **Running now**: ${running.slice(-3).map((entry) => entry.name).join(', ')}`);
    }
    const failed = activeBuild.testCases.filter((entry) => entry && entry.status === 'failed');
    if (failed.length > 0) {
      lines.push(`- **Failed**: ${failed.slice(0, 3).map((entry) => entry.name).join(', ')}`);
    }
  }

  if (Array.isArray(buildHistory) && buildHistory.length > 0) {
    const recent = buildHistory.slice(-3).reverse();
    lines.push('- **Recent Builds**:');
    for (const item of recent) {
      const dur = formatElapsedShort(item.startedAt, item.finishedAt);
      lines.push(
        `  • [${statusBadge(item.status)}] \`${item.target}\`${dur ? ` (${dur})` : ''}${item.stage ? ` — ${item.stage}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Safely parse event detail which may be a JSON-encoded build payload or plain text.
 *
 * @param {string|any} detail
 * @returns {{ isBuild: boolean, data: object|null, text: string }}
 */
function parseEventDetail(detail) {
  if (detail === null || detail === undefined) return { isBuild: false, data: null, text: '' };
  if (typeof detail === 'object') {
    const isBuild = Boolean(
      detail.target || detail.command || detail.stage || detail.buildHost || detail.status || detail.progress !== undefined || detail.output || detail.jobUrl || detail.url || detail.buildUrl
    );
    return {
      isBuild,
      data: isBuild ? detail : null,
      text: detail.output || detail.stage || detail.target || JSON.stringify(detail),
    };
  }
  const str = String(detail).trim();
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object') {
        const isBuild = Boolean(
          obj.target || obj.command || obj.stage || obj.buildHost || obj.status || obj.progress !== undefined || obj.output || obj.jobUrl || obj.url || obj.buildUrl
        );
        return {
          isBuild,
          data: isBuild ? obj : null,
          text: obj.output || obj.stage || obj.target || str,
        };
      }
    } catch {
      // not JSON
    }
  }
  return { isBuild: false, data: null, text: str };
}

/**
 * Reconstruct the latest active build per session_key (or project_name fallback)
 * from recent monitor events (`build_started`, `build_progress`, `build_succeeded`,
 * `build_failed`, `tests_passed`, `tests_failed`, `release`).
 *
 * Events are expected in newest-first order (as returned by `ORDER BY at DESC`).
 */
function extractActiveBuildFromEvents(events = []) {
  const bySession = new Map();
  if (!Array.isArray(events)) return bySession;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = String(ev.kind || '');
    if (!kind.startsWith('build_') && kind !== 'tests_passed' && kind !== 'tests_failed' && kind !== 'release') {
      continue;
    }

    const key = cleanStr(ev.session_key || ev.sessionKey || '', 200) ||
      (ev.machine && ev.project_name ? `${ev.machine}::${ev.project_name}` : '');
    if (!key || bySession.has(key)) continue;

    const rawDetail = String(ev.detail || '').trim();
    const parsedEvent = parseEventDetail(rawDetail);
    if (parsedEvent.isBuild && parsedEvent.data) {
      bySession.set(
        key,
        normalizeBuildState({
          ...parsedEvent.data,
          updatedAt: ev.at || parsedEvent.data.updatedAt,
        }),
      );
      continue;
    }

    // Fallback for plain-text build/test/release events
    const status =
      kind === 'build_failed' || kind === 'tests_failed'
        ? 'failed'
        : kind === 'build_succeeded' || kind === 'tests_passed' || kind === 'release'
          ? 'succeeded'
          : kind === 'build_progress'
            ? 'building'
            : 'building';

    bySession.set(
      key,
      normalizeBuildState({
        status,
        target: ev.project_name || 'Build / Test Execution',
        stage: rawDetail.slice(0, 200),
        startedAt: ev.at || new Date().toISOString(),
        updatedAt: ev.at || new Date().toISOString(),
      }),
    );
  }

  return bySession;
}

module.exports = {
  VALID_BUILD_STATUSES,
  normalizeBuildState,
  formatBuildStatusBlock,
  extractActiveBuildFromEvents,
  parseEventDetail,
  formatElapsedShort,
  statusBadge,
  summarizeTestCases,
};
