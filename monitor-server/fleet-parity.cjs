'use strict';

/**
 * Fleet parity: is every device running the same thing?
 *
 * OWNER REQUEST (10 November 2026)
 * --------------------------------
 * "I want this version in the dev-workflow monitor, so we can tell whether the
 * version is the same everywhere, whether the MCP is the same and active on all
 * of them, and whether the commands we need are the same everywhere — gh, glab,
 * wrangler, gcloud. We must all have the same tools."
 *
 * WHY A MAJORITY AND NOT "MATCH THE FIRST"
 * ----------------------------------------
 * Comparing every machine to whichever row happened to come back first makes a
 * single stale device look like the reference. The majority is the value most
 * machines actually run, so the odd one out is the one flagged. With an even
 * split there is no majority; the view then says so instead of inventing one.
 *
 * WHY "NOT REPORTED" IS NOT "DRIFT"
 * ---------------------------------
 * A machine that has not yet run the version-carrying release reports nothing.
 * Calling that drift would light up every device after a deploy and teach the
 * reader to ignore the flag. So a machine with no version and no toolchain is
 * `unreported`, and only a machine that reported something different is
 * `drift`. Missing is its own state: an empty value means "not reported yet", a
 * null inside a toolchain means "the tool is not installed", and a version means
 * "this is what runs".
 */

/** The value that appears most often; null when there is no clear winner. */
function majority(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size === 0) return null;

  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Reads a toolchain column defensively; anything odd becomes an empty map. */
function asToolchain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Builds the parity view from machine rows.
 *
 * @param {Array<object>} machines rows with machine, release_version,
 *   release_revision, toolchain_json, stale
 * @param {{ approvedRelease?: {version: string, revision: string}|null, fleetManifest?: object|null }} options
 *   the release the fleet is supposed to run, and the pinned toolchain. When
 *   absent the majority of what machines reported is used, and `targetSource`
 *   says so.
 */
function buildFleetParity(machines = [], { approvedRelease = null, fleetManifest = null } = {}) {
  const rows = Array.isArray(machines) ? machines.filter((m) => m && m.machine) : [];

  const reportedVersion = majority(rows.map((m) => m.release_version));
  const reportedRevision = majority(rows.map((m) => m.release_revision));

  // A decision beats a vote. Only a well-formed approved release may become the
  // target; anything else falls back to the reported majority rather than
  // silently turning a broken release file into "no target".
  const approved =
    approvedRelease && typeof approvedRelease === 'object' && approvedRelease.version && approvedRelease.revision
      ? approvedRelease
      : null;
  const version = approved ? approved.version : reportedVersion;
  const revision = approved ? approved.revision : reportedRevision;
  const targetSource = approved ? 'approved' : 'reported-majority';

  // A pin is a decision, a majority is a poll. A tool the fleet has agreed on
  // must not be "outvoted" by machines that have not been updated yet, or the
  // panel recommends the stale version to everyone.
  const pinnedTools =
    fleetManifest && typeof fleetManifest.tools === 'object' && fleetManifest.tools ? fleetManifest.tools : null;

  // The union of pinned tools and tools any machine reported, so a tool missing
  // everywhere is still listed rather than silently absent.
  const toolNames = [];
  if (pinnedTools) {
    for (const name of Object.keys(pinnedTools)) toolNames.push(name);
  }
  for (const row of rows) {
    for (const name of Object.keys(asToolchain(row.toolchain_json))) {
      if (!toolNames.includes(name)) toolNames.push(name);
    }
  }
  toolNames.sort();

  const tools = toolNames.map((name) => {
    const values = rows.map((row) => {
      const toolchain = asToolchain(row.toolchain_json);
      return Object.prototype.hasOwnProperty.call(toolchain, name) ? toolchain[name] : undefined;
    });
    const pin =
      pinnedTools && Object.prototype.hasOwnProperty.call(pinnedTools, name) ? pinnedTools[name] : null;
    // Only installed versions can define the fallback expectation; `null` means
    // the tool is genuinely absent and must not become the expectation.
    const expected = pin || majority(values.filter((v) => v !== null && v !== undefined));
    return {
      name,
      expected,
      pinned: Boolean(pin),
      machines: rows.map((row, index) => ({
        machine: row.machine,
        version: values[index] === undefined ? null : values[index],
        reported: values[index] !== undefined,
      })),
    };
  });

  const view = rows.map((row) => {
    const toolchain = asToolchain(row.toolchain_json);
    const hasVersion = Boolean(row.release_version);
    const hasToolchain = Object.keys(toolchain).length > 0;

    const versionDiffers = hasVersion && version !== null && row.release_version !== version;
    const revisionDiffers = Boolean(row.release_revision) && revision !== null && row.release_revision !== revision;
    const missingTools = toolNames.filter(
      (name) => Object.prototype.hasOwnProperty.call(toolchain, name) && toolchain[name] === null
    );
    const driftedTools = toolNames.filter((name) => {
      const expected = (tools.find((t) => t.name === name) || {}).expected;
      const actual = toolchain[name];
      return Boolean(expected) && Boolean(actual) && actual !== expected;
    });

    // Version and toolchain answer two different questions ("is the MCP the
    // same?" and "can every device run the same work?"), so each gets its own
    // verdict. Collapsing them produced a false green: three devices showed
    // "in sync" while not one of them had ever reported a tool version.
    const versionStatus = !hasVersion ? 'unreported' : versionDiffers || revisionDiffers ? 'differs' : 'same';
    const toolsStatus = !hasToolchain
      ? 'unreported'
      : missingTools.length > 0 || driftedTools.length > 0
        ? 'differs'
        : 'same';

    const status =
      versionStatus === 'differs' || toolsStatus === 'differs'
        ? 'drift'
        : versionStatus === 'unreported' || toolsStatus === 'unreported'
          ? 'unreported'
          : 'in-sync';

    const convergenceStatus = row.stale
      ? 'OFFLINE'
      : versionDiffers || revisionDiffers
        ? // With an approved target, a machine that differs is simply not running
          // it yet; the fix is a client refresh, not a debate about which version
          // is correct.
          approved
          ? 'CLIENT_REFRESH_REQUIRED'
          : row.last_phase && row.last_phase !== 'idle'
            ? 'PINNED_ACTIVE_SESSION'
            : 'VERSION_MISMATCH'
        : status === 'in-sync'
          ? 'CONVERGED'
          : 'CLIENT_REFRESH_REQUIRED';

    return {
      machine: row.machine,
      version: row.release_version || null,
      // "Installed" is a different fact from "running", and nothing reports it
      // yet. Copying the running version here made the panel claim an
      // installation nobody had verified.
      installedVersion: row.installed_version || null,
      runningVersion: row.release_version || null,
      targetVersion: version || row.release_version || null,
      targetSource,
      revision: row.release_revision || null,
      toolCatalogDigest: row.tool_catalog_digest || (toolchain && toolchain.toolCatalogDigest) || null,
      convergenceStatus,
      activeSessionCount: Number(row.active_sessions ?? (row.last_phase && row.last_phase !== 'idle' ? 1 : 0)),
      updateFailureReason: row.update_failure_reason || null,
      stale: Boolean(row.stale),
      status,
      versionStatus,
      toolsStatus,
      inSync: status === 'in-sync',
      versionMismatch: versionDiffers,
      revisionMismatch: revisionDiffers,
      missingTools,
      driftedTools,
      toolchain,
    };
  });

  return {
    version,
    revision,
    targetSource,
    tools,
    machines: view,
    mismatched: view.filter((m) => m.status === 'drift').map((m) => m.machine),
    unreported: view.filter((m) => m.status === 'unreported').map((m) => m.machine),
  };
}

module.exports = { buildFleetParity, majority };
