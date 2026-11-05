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
  const sameRunningBuild = prev.target === target && !['succeeded', 'failed', 'idle'].includes(prev.status);
  const buildHost = cleanStr(
    input.buildHost !== undefined ? input.buildHost : sameRunningBuild ? prev.buildHost : '',
    120,
  );
  const command = cleanStr(
    input.command !== undefined ? input.command : prev.command || '',
    300,
  );
  const stage = cleanStr(
    input.stage !== undefined ? input.stage : prev.stage || '',
    240,
  );
  const output = cleanStr(
    input.output !== undefined ? input.output : prev.output || '',
    600,
  );

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

  const startedAt = cleanStr(
    input.startedAt || (wasActive ? prev.startedAt : nowIso),
    64,
  );
  const updatedAt = cleanStr(input.updatedAt || nowIso, 64);
  const finishedAt = isTerminal ? cleanStr(input.finishedAt || nowIso, 64) : '';

  return {
    status,
    target,
    buildHost,
    command,
    stage,
    progress,
    output,
    startedAt,
    updatedAt,
    finishedAt,
  };
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
    let parsed = null;
    if (rawDetail.startsWith('{') && rawDetail.endsWith('}')) {
      try {
        parsed = JSON.parse(rawDetail);
      } catch {
        parsed = null;
      }
    }

    if (parsed && typeof parsed === 'object') {
      bySession.set(
        key,
        normalizeBuildState({
          ...parsed,
          updatedAt: ev.at || parsed.updatedAt,
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
  formatElapsedShort,
  statusBadge,
};
