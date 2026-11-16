#!/usr/bin/env node
/**
 * `toolchain-doctor` - does this machine carry the pinned fleet toolchain?
 *
 * WHY A CLI
 * ---------
 * The monitor can only report what a machine speaks up about, and a machine
 * that is idle never speaks. This command makes the same check runnable on any
 * machine, on demand, without a session, a task or a network call: install,
 * then ask the machine itself. Exit code 1 on any drift so a rollout script can
 * depend on the result instead of parsing prose.
 *
 * The pins live in managed/fleet-toolchain.json. Nothing here hardcodes a
 * version; a hardcoded default is how the fleet panel ended up recommending
 * 1.31.0 while the approved release was 1.32.1.
 *
 * Usage:
 *   node scripts/toolchain-doctor.mjs [--json] [--manifest <path>]
 */
import { exec } from "../exec.js";
import {
  compareToolchainToManifest,
  createToolchainProbe,
  detectToolchain,
  loadFleetManifest,
} from "../toolchain.js";

const USAGE = `toolchain-doctor - compare this machine to the pinned fleet toolchain

Usage:
  node scripts/toolchain-doctor.mjs [--json] [--manifest <path>]

Exit codes:
  0  every pinned tool is installed at the pinned version
  1  drift or a missing tool (see the report)
  2  the manifest could not be read
`;

function parseArgv(argv) {
  const options = { json: false, manifest: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--manifest") {
      options.manifest = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArgv(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const manifest = loadFleetManifest(options.manifest ? { file: options.manifest } : {});
  if (!manifest) {
    process.stderr.write("Cannot read the fleet manifest. Nothing was compared.\n");
    return 2;
  }

  const detected = await detectToolchain({ run: createToolchainProbe({ exec }) });
  const report = compareToolchainToManifest(manifest, detected);
  const payload = {
    machine: process.env.DEVWF_MACHINE || null,
    platform: process.platform,
    arch: process.arch,
    manifestUpdated: manifest.updated || null,
    managedMcp: manifest.managedMcp || null,
    ...report,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return report.inSync ? 0 : 1;
  }

  process.stdout.write(`Fleet toolchain ${manifest.updated || ""} on ${process.platform}/${process.arch}\n`);
  for (const row of report.rows) {
    const actual = row.actual || "missing";
    process.stdout.write(`  ${row.status.toUpperCase().padEnd(7)} ${row.tool.padEnd(9)} ${String(row.pinned).padEnd(10)} ${actual}\n`);
  }
  if (manifest.managedMcp) {
    process.stdout.write(`ManagedMCP pin: ${manifest.managedMcp.version} (${String(manifest.managedMcp.revision).slice(0, 12)})\n`);
  }
  process.stdout.write(report.inSync ? "In sync.\n" : `Drift: ${report.mismatched.join(", ")}\n`);
  return report.inSync ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
