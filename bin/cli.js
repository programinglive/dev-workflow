#!/usr/bin/env node
/**
 * `devwf` — close sessions and cards without the web monitor.
 *
 * This file is a wire, not a policy: parse, dispatch, print, set an exit code.
 * Every refusal rule lives in `cli/commands.js`, every HTTP detail in
 * `cli/monitor-client.js`. Keeping the entry point empty of decisions is what
 * lets the rules be tested without spawning a process.
 *
 * Exit codes are the contract: 0 only when the action really happened (or a
 * dry run really validated). Refusals, unknown sessions and monitor errors are
 * non-zero so a shell script can depend on the result.
 */
import { parseArgs, CliError, USAGE } from "../cli/args.js";
import { runCommand, preflight } from "../cli/commands.js";
import { createMonitorClient } from "../cli/monitor-client.js";
import { createSessions, createHandlers } from "../cli/runtime.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`devwf ${readVersion()}\n`);
    return 0;
  }

  const out = { write: (line) => process.stdout.write(`${line}\n`) };

  // Argument mistakes are reported before configuration mistakes: this throws
  // for a missing --session or --reason before any client reads the env.
  preflight(args);

  // The monitor is only built for commands that talk to it, so `drop` and
  // `complete` still work on a machine with no DEVWF_MONITOR_URL configured.
  const needsMonitor = ["list", "close", "share"].includes(args.command);
  const monitor = needsMonitor ? createMonitorClient({ env: process.env }) : null;

  const sessions = args.command === "list" ? null : createSessions({ env: process.env });
  const handlers = ["drop", "complete"].includes(args.command)
    ? createHandlers({ out })
    : null;

  const result = await runCommand({ args, env: process.env, out, monitor, sessions, handlers });
  return result?.ok === false ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof CliError ? error.message : String(error?.stack || error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
