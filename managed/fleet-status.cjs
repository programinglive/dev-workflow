#!/usr/bin/env node
'use strict';

/**
 * CLI tool to inspect fleet-wide Dev Workflow MCP version and toolchain parity
 * from the central monitor (`http://100.77.138.14:3100/api/sessions`).
 *
 * Usage:
 *   node managed/fleet-status.cjs
 *   node managed/fleet-status.cjs --json
 *   node managed/fleet-status.cjs --strict
 */

const DEFAULT_MONITOR_URL = 'http://100.77.138.14:3100';

/**
 * Evaluate fleet parity from the monitor `/api/sessions` payload.
 */
function evaluateFleetParity(payload) {
  const fleet = payload?.fleet || {};
  const targetVersion = fleet.version || null;
  const targetRevision = fleet.revision || null;
  const expectedTools = Array.isArray(fleet.tools)
    ? fleet.tools.filter((t) => t && t.pinned && t.expected)
    : [];

  const machines = (Array.isArray(payload?.machines) ? payload.machines : []).map((m) => {
    const versionMatch = !targetVersion || m.release_version === targetVersion;
    const revisionMatch = !targetRevision || m.release_revision === targetRevision;
    const toolchain = m.toolchain_json || {};
    const toolDrifts = [];

    for (const tool of expectedTools) {
      const actual = toolchain[tool.name] || null;
      if (actual !== tool.expected) {
        toolDrifts.push({
          name: tool.name,
          actual: actual || '(missing)',
          expected: tool.expected,
        });
      }
    }

    return {
      machine: m.machine,
      releaseVersion: m.release_version || null,
      releaseRevision: m.release_revision || null,
      lastSeen: m.last_seen || null,
      versionMatch,
      revisionMatch,
      toolDrifts,
      ok: versionMatch && revisionMatch && toolDrifts.length === 0,
    };
  });

  const ok = machines.length > 0 && machines.every((m) => m.ok);
  return {
    ok,
    targetVersion,
    targetRevision,
    machines,
  };
}

/**
 * Format a human-readable fleet parity summary for terminal output.
 */
function formatFleetReport(report) {
  const lines = [
    `Fleet Target: v${report.targetVersion || '?'} (${(report.targetRevision || '').slice(0, 7) || '?'})`,
    '',
  ];

  for (const m of report.machines) {
    const icon = m.ok ? '✅' : '⚠️';
    const rev = m.releaseRevision ? m.releaseRevision.slice(0, 7) : '-';
    const drifts = m.toolDrifts.map((d) => `${d.name} ${d.actual} != ${d.expected}`).join(', ');
    const extras = [];
    if (!m.versionMatch) extras.push(`version ${m.releaseVersion || '-'} != ${report.targetVersion}`);
    if (drifts) extras.push(`tools: ${drifts}`);
    lines.push(
      `${icon} ${m.machine}: v${m.releaseVersion || '-'} (${rev})${extras.length ? ` — ${extras.join('; ')}` : ''}`
    );
  }

  return lines.join('\n');
}

async function fetchFleetStatus(monitorUrl) {
  const base = String(monitorUrl || DEFAULT_MONITOR_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/sessions`);
  if (!res.ok) {
    throw new Error(`Monitor returned HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');
  const urlIdx = args.indexOf('--url');
  const monitorUrl =
    (urlIdx >= 0 && args[urlIdx + 1]) ||
    process.env.DEVWF_MONITOR_URL ||
    DEFAULT_MONITOR_URL;

  const payload = await fetchFleetStatus(monitorUrl);
  const report = evaluateFleetParity(payload);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatFleetReport(report));
  }

  if (strict && !report.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluateFleetParity,
  formatFleetReport,
  fetchFleetStatus,
};
