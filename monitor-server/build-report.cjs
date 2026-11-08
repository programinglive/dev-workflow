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

module.exports = { pairBuildRuns };
