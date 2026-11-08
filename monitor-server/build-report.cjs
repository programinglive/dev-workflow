'use strict';

/**
 * Build duration report: from recorded build events to run durations, stage
 * breakdowns, percentiles and a minute-level estimate.
 *
 * This module is deliberately pure: it takes event rows and an explicit `now`,
 * imports nothing from `pg`, `http` or `child_process`, and never reads the
 * clock on its own. Every rule the report and the ETA rely on therefore has a
 * test that needs no database, no monitor and no waiting.
 */

/** Parse the JSON `detail` written by report_build_status without ever throwing. */
function parseDetail(detail) {
  if (detail && typeof detail === 'object') return detail;
  try {
    return JSON.parse(String(detail || '{}')) || {};
  } catch {
    return {};
  }
}

function toMs(value) {
  const ms = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ms) ? ms : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stripInternal(run) {
  const copy = {};
  for (const [key, value] of Object.entries(run)) {
    if (key.startsWith('_')) continue;
    copy[key] = value;
  }
  return copy;
}

function pushStage(run, stage, durationMs) {
  const name = String(stage || '').trim();
  if (!name) return;
  const ms = Math.round(durationMs);
  // A zero-length interval carries no information and would drag a stage
  // baseline towards zero, so it is not recorded.
  if (!Number.isFinite(ms) || ms <= 0) return;
  run.stages.push({ stage: name, durationMs: ms });
}

/**
 * Turn the build event stream into completed runs and the ones still open.
 *
 * A run is keyed by session + target: a `build_started` opens it, and
 * `build_succeeded` / `build_failed` closes it. Progress events only move the
 * stage clock. Anything still open at the end of the window is `unclosed` and
 * contributes no duration, because a missing terminal event is not evidence of
 * a fast build.
 *
 * @param {Array<{at: string, session_key?: string, project_name?: string, kind: string, detail?: string|object}>} events
 * @returns {{runs: Array<object>, unclosed: Array<object>}}
 */
function pairBuildRuns(events = []) {
  const runs = [];
  const unclosed = [];
  const open = new Map();

  const ordered = [...(Array.isArray(events) ? events : [])].sort(
    (a, b) => (toMs(a && a.at) ?? 0) - (toMs(b && b.at) ?? 0)
  );

  for (const row of ordered) {
    if (!row) continue;
    const kind = String(row.kind || '');
    if (!kind.startsWith('build_')) continue;

    const detail = parseDetail(row.detail);
    const target = String(detail.target || '');
    const key = `${row.session_key || ''}|${target}`;
    const eventMs = toMs(row.at) ?? 0;
    const project = String(row.project_name || detail.project || '');
    const host = String(detail.buildHost || detail.machine || row.machine || '');

    if (kind === 'build_started') {
      const previous = open.get(key);
      if (previous) unclosed.push({ ...stripInternal(previous), durationMs: null });
      open.set(key, {
        sessionKey: String(row.session_key || ''),
        project,
        host,
        target,
        command: String(detail.command || ''),
        status: 'running',
        startedAt: detail.startedAt || row.at,
        finishedAt: null,
        durationMs: null,
        stages: [],
        _lastEventMs: eventMs,
        _lastStage: String(detail.stage || ''),
      });
      continue;
    }

    const run = open.get(key);
    if (!run) continue;

    if (kind === 'build_progress') {
      const stage = String(detail.stage || '');
      if (stage && stage !== run._lastStage) {
        pushStage(run, run._lastStage, eventMs - run._lastEventMs);
        run._lastStage = stage;
        run._lastEventMs = eventMs;
      }
      continue;
    }

    if (kind === 'build_succeeded' || kind === 'build_failed') {
      const finishedAt = detail.finishedAt || row.at;
      const startedMs = toMs(detail.startedAt || run.startedAt) ?? eventMs;
      const finishedMs = toMs(finishedAt) ?? eventMs;
      pushStage(run, run._lastStage, finishedMs - run._lastEventMs);
      runs.push({
        ...stripInternal(run),
        status: kind === 'build_succeeded' ? 'succeeded' : 'failed',
        startedAt: detail.startedAt || run.startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedMs - startedMs),
      });
      open.delete(key);
    }
  }

  for (const run of open.values()) {
    unclosed.push({ ...stripInternal(run), durationMs: null });
  }

  return { runs, unclosed };
}

/**
 * Nearest-rank percentile over real observed values.
 *
 * Interpolating would invent a duration that never happened; the report is used
 * to promise a number of minutes, so every returned value is a build that
 * actually ran.
 *
 * @param {number[]} values unsorted durations in milliseconds
 * @param {number} p percentile 0..100
 * @returns {number|null} null when there is nothing to rank
 */
function percentile(values, p) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const clamped = Math.min(100, Math.max(0, Number(p) || 0));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((clamped / 100) * sorted.length) - 1));
  return sorted[index];
}

function groupCount(durations) {
  const valid = durations.filter((value) => Number.isFinite(value));
  return {
    count: valid.length,
    p50Ms: percentile(valid, 50),
    p90Ms: percentile(valid, 90),
  };
}

function stageAggregates(runs) {
  const byStage = new Map();
  for (const run of runs) {
    for (const stage of Array.isArray(run.stages) ? run.stages : []) {
      if (!stage || !stage.stage || !Number.isFinite(stage.durationMs) || stage.durationMs <= 0) continue;
      if (!byStage.has(stage.stage)) byStage.set(stage.stage, []);
      byStage.get(stage.stage).push(stage.durationMs);
    }
  }
  return [...byStage.entries()]
    .map(([stage, durations]) => ({ stage, count: durations.length, p50Ms: percentile(durations, 50) }))
    .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));
}

/**
 * Aggregate completed runs into the report payload.
 *
 * Only succeeded runs feed the baseline: a fast failure is not evidence that a
 * build takes less time. Failed runs are counted in `totals`, and unclosed runs
 * are counted but never timed.
 *
 * @param {Array<object>} runs completed runs from pairBuildRuns
 * @param {{trendLimit?: number, unclosed?: Array<object>}} [options]
 */
function summarizeRuns(runs = [], { trendLimit = 20, unclosed = [] } = {}) {
  const list = (Array.isArray(runs) ? runs : []).filter(Boolean);
  const succeeded = list.filter((run) => run.status === 'succeeded');
  const failed = list.filter((run) => run.status === 'failed');

  const byProject = new Map();
  for (const run of list) {
    const project = String(run.project || run.host || run.target || 'unknown');
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push(run);
  }

  const projects = [...byProject.entries()]
    .map(([project, projectRuns]) => {
      const ok = projectRuns.filter((run) => run.status === 'succeeded');
      const durations = ok.map((run) => run.durationMs).filter((value) => Number.isFinite(value));

      const byTarget = new Map();
      for (const run of ok) {
        const target = String(run.target || '');
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(run.durationMs);
      }

      return {
        project,
        count: ok.length,
        p50Ms: percentile(durations, 50),
        p90Ms: percentile(durations, 90),
        maxMs: durations.length ? Math.max(...durations) : null,
        minMs: durations.length ? Math.min(...durations) : null,
        meanMs: durations.length
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : null,
        trend: ok.slice(-trendLimit).map((run) => ({
          at: run.finishedAt || run.startedAt || null,
          durationMs: run.durationMs,
          status: run.status,
        })),
        targets: [...byTarget.entries()]
          .map(([target, values]) => ({ target, ...groupCount(values) }))
          .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target)),
        stages: stageAggregates(ok),
        // The estimator needs the stage sequence to project what is still ahead;
        // the latest successful run is the best available order.
        stageOrder: ok.length ? ok[ok.length - 1].stages.map((stage) => stage.stage) : [],
      };
    })
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));

  const slowest = list
    .filter((run) => Number.isFinite(run.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((run) => ({
      project: run.project || '',
      target: run.target || '',
      durationMs: run.durationMs,
      at: run.finishedAt || run.startedAt || null,
      status: run.status,
    }));

  return {
    totals: {
      runs: list.length,
      succeeded: succeeded.length,
      failed: failed.length,
      unclosed: Array.isArray(unclosed) ? unclosed.length : 0,
    },
    projects,
    slowest,
  };
}

const MIN_SAMPLES = 5;
const STALL_MS = 120000;

const clamp0 = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);
const minutes = (ms) => Math.round((Number(ms) || 0) / 60000);

function isRevised(previous, next) {
  if (!previous || typeof previous !== 'object') return false;
  if (String(previous.state || '') !== String(next.state || '')) return true;
  const pairs = [
    ['remainingLowMs', previous.remainingLowMs, next.remainingLowMs],
    ['remainingHighMs', previous.remainingHighMs, next.remainingHighMs],
  ];
  for (const [, before, after] of pairs) {
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const base = Math.max(1, Math.abs(before));
    if (Math.abs(after - before) / base > 0.2) return true;
  }
  return false;
}

/**
 * Estimate how long a build still needs, and revise that estimate when the
 * build gets into trouble.
 *
 * A frozen number is worse than no number: it says everything is fine while the
 * build is stuck. The decision order is therefore failure, missing baseline,
 * stall, overdue, stage baseline, progress, history — the first condition that
 * matches wins, and the reason is always carried so the UI can show why the
 * number changed.
 *
 * @param {object} input
 * @param {object} input.summary project/target summary with p50Ms, p90Ms, stages
 * @param {object} input.run live build state (status, startedAt, progress, stage)
 * @param {number|string} input.now explicit clock, so tests never wait
 * @param {object|null} [input.previous] last estimate, to mark a revision
 */
function estimateBuild({
  summary = {},
  run = {},
  now = Date.now(),
  previous = null,
  minSamples = MIN_SAMPLES,
  stallMs = STALL_MS,
} = {}) {
  const nowMs = typeof now === 'number' ? now : toMs(now) ?? Date.now();
  const startedMs = toMs(run.startedAt) ?? nowMs;
  const elapsed = Math.max(0, nowMs - startedMs);
  const status = String(run.status || 'running');
  const count = Number(summary.count) || 0;
  const p50 = Number.isFinite(summary.p50Ms) ? summary.p50Ms : null;
  const p90 = Number.isFinite(summary.p90Ms) ? summary.p90Ms : null;

  const finish = (patch) => {
    const estimate = {
      available: false,
      state: 'no-baseline',
      sampleCount: count,
      remainingLowMs: null,
      remainingHighMs: null,
      totalLowMs: null,
      totalHighMs: null,
      basis: 'none',
      reason: '',
      revised: false,
      elapsedMs: clamp0(elapsed),
      ...patch,
    };
    estimate.revised = isRevised(previous, estimate);
    return estimate;
  };

  if (status === 'failed') {
    return finish({ state: 'failed', reason: `failed after ${minutes(elapsed)}m` });
  }
  if (status === 'succeeded') {
    return finish({ state: 'succeeded', reason: `finished in ${minutes(elapsed)}m` });
  }
  if (count < minSamples || p50 === null || p90 === null) {
    return finish({ state: 'no-baseline', reason: `belum ada baseline (${count} build)` });
  }

  const progress = numberOrNull(run.progress);
  const previousProgress = numberOrNull(run.previousProgress);
  const progressChangedAt = toMs(run.progressUpdatedAt) ?? startedMs;
  const sinceProgress = Math.max(0, nowMs - progressChangedAt);
  const historyRange = {
    remainingLowMs: clamp0(p50 - elapsed),
    remainingHighMs: clamp0(p90 - elapsed),
  };

  if (progress !== null && previousProgress !== null && progress < previousProgress) {
    return finish({ available: true, state: 'stalled', basis: 'history', reason: 'progress regressed', ...historyRange });
  }
  if (progress !== null && sinceProgress >= stallMs && elapsed >= stallMs) {
    return finish({
      available: true,
      state: 'stalled',
      basis: 'history',
      reason: `no progress for ${minutes(sinceProgress)}m`,
      ...historyRange,
    });
  }
  if (elapsed > p90) {
    return finish({
      available: true,
      state: 'overdue',
      basis: 'history',
      reason: `lewat p90 (${minutes(elapsed)}m > ${minutes(p90)}m, p50 ${minutes(p50)}m)`,
    });
  }

  const stage = String(run.stage || '');
  const stageOrder = Array.isArray(summary.stageOrder) ? summary.stageOrder.map(String) : [];
  const stageP50 = new Map(
    (Array.isArray(summary.stages) ? summary.stages : [])
      .filter((entry) => entry && entry.stage && Number.isFinite(entry.p50Ms))
      .map((entry) => [String(entry.stage), entry.p50Ms])
  );
  if (stage && stageP50.has(stage) && stageOrder.includes(stage)) {
    const stageStartedMs = toMs(run.stageStartedAt) ?? startedMs;
    const timeInStage = Math.max(0, nowMs - stageStartedMs);
    const currentRemaining = clamp0(stageP50.get(stage) - timeInStage) ?? 0;
    const notStarted = stageOrder
      .slice(stageOrder.indexOf(stage) + 1)
      .reduce((sum, name) => sum + (stageP50.get(name) || 0), 0);
    const remainingLow = currentRemaining + notStarted;
    const remainingHigh = Math.max(remainingLow, p90 - elapsed);
    return finish({
      available: true,
      state: 'on-track',
      basis: 'stage',
      reason: `stage ${stage}`,
      remainingLowMs: clamp0(remainingLow),
      remainingHighMs: clamp0(remainingHigh),
      totalLowMs: clamp0(elapsed + remainingLow),
      totalHighMs: clamp0(elapsed + remainingHigh),
    });
  }

  if (progress !== null && progress > 0 && progress < 100) {
    const projectedTotal = elapsed / (progress / 100);
    const remaining = Math.max(0, projectedTotal - elapsed);
    return finish({
      available: true,
      state: 'on-track',
      basis: 'progress',
      reason: `progress ${Math.round(progress)}%`,
      remainingLowMs: clamp0(Math.min(remaining, p50 - elapsed)),
      remainingHighMs: clamp0(Math.max(remaining, p90 - elapsed)),
      totalLowMs: clamp0(elapsed + Math.min(remaining, p50 - elapsed)),
      totalHighMs: clamp0(elapsed + Math.max(remaining, p90 - elapsed)),
    });
  }

  return finish({
    available: true,
    state: 'on-track',
    basis: 'history',
    reason: `p50 ${minutes(p50)}m, p90 ${minutes(p90)}m`,
    remainingLowMs: historyRange.remainingLowMs,
    remainingHighMs: historyRange.remainingHighMs,
    totalLowMs: p50,
    totalHighMs: p90,
  });
}

/**
 * SQL for the report window.
 *
 * Only build events are read, and the window is clamped to the event retention
 * so the report can never promise history the pruner already deleted.
 *
 * @param {{days?: number, project?: string|null, host?: string|null}} [options]
 */
function buildReportQuery({ days = 30, project = null, host = null } = {}) {
  // `days: 0` must clamp to 1, not fall back to the default: `Number(0) || 30`
  // would silently widen a window the caller asked to narrow.
  const requested = days === null || days === undefined || days === '' ? 30 : Number(days);
  const windowDays = String(Math.min(30, Math.max(1, Number.isFinite(requested) ? requested : 30)));
  const params = [windowDays];
  const conditions = [`at >= now() - ($1::text || ' days')::interval`];

  if (project) {
    params.push(String(project));
    conditions.push(`project_name = $${params.length}`);
  }
  if (host) {
    params.push(String(host));
    // buildHost lives inside the JSON detail; matching it here keeps the report
    // filterable without a schema change.
    conditions.push(`detail::jsonb->>'buildHost' = $${params.length}`);
  }

  return {
    sql: `SELECT at, session_key, project_name, kind, detail
            FROM events
           WHERE kind LIKE 'build_%'
             AND ${conditions.join(' AND ')}
           ORDER BY at ASC`,
    params,
  };
}

/**
 * Shape the report the dashboard, the API and the MCP tool all read.
 *
 * @param {Array<object>} rows event rows from buildReportQuery
 * @param {{days?: number, now?: string|number}} [options]
 */
function buildReportPayload(rows = [], { days = 30, now = new Date().toISOString() } = {}) {
  const { runs, unclosed } = pairBuildRuns(rows);
  const summary = summarizeRuns(runs, { unclosed });
  return {
    window_days: Number(days) || 30,
    generated_at: typeof now === 'number' ? new Date(now).toISOString() : String(now),
    totals: summary.totals,
    projects: summary.projects,
    slowest: summary.slowest,
    unclosed: unclosed.map((run) => ({
      project: run.project || '',
      target: run.target || '',
      host: run.host || '',
      started_at: run.startedAt || null,
    })),
  };
}

module.exports = {
  pairBuildRuns,
  percentile,
  summarizeRuns,
  estimateBuild,
  buildReportQuery,
  buildReportPayload,
  // Exported so the dashboard page can inline the exact same estimator instead
  // of growing a second implementation that drifts from the tool's answer.
  MIN_SAMPLES,
  STALL_MS,
  toMs,
  numberOrNull,
  clamp0,
  minutes,
  isRevised,
};
