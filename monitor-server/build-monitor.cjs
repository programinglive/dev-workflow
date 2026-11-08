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
 * Safely parse event detail which may be a JSON-encoded build payload or plain text.
 *
 * @param {string|any} detail
 * @returns {{ isBuild: boolean, data: object|null, text: string }}
 */
function parseEventDetail(detail) {
  if (detail === null || detail === undefined) return { isBuild: false, data: null, text: '' };
  if (typeof detail === 'object') {
    const isBuild = Boolean(
      detail.target || detail.command || detail.stage || detail.buildHost || detail.status || detail.progress !== undefined || detail.output
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
          obj.target || obj.command || obj.stage || obj.buildHost || obj.status || obj.progress !== undefined || obj.output
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
};
