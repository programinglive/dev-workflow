/**
 * Argument parsing for the `devwf` CLI.
 *
 * Pure: no filesystem, no network, no process access. Every rule here is a
 * statement about what the owner typed, so it stays unit-testable without a
 * running monitor or a real state directory.
 *
 * WHY AN EXPLICIT TARGET IS THE DEFAULT
 * -------------------------------------
 * `close`, `drop` and `complete` all take work away from someone. A command
 * that silently acts on "the current session" deletes the wrong session once,
 * and that is unrecoverable. There is no fallback target here: a missing
 * `--session` is refused before any file is read or any request is sent, and
 * only `list` runs without one.
 */

const COMMANDS = ["list", "close", "share", "drop", "complete", "help", "version", "doctor", "pair"];

/** A refusal the CLI reports to the user and turns into a non-zero exit. */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export const USAGE = `devwf - close sessions and cards without the web monitor

Usage:
  devwf doctor                                 Check environment, node, and storage diagnostics
  devwf pair [--url <url>] [--json]            Generate pairing challenge for mobile companion
  devwf list                                  List sessions from the monitor
  devwf close --session <key> [--dry-run]      Mark one session closed
  devwf share list                             List live share links
  devwf share revoke --token <t> [--dry-run]   Revoke one share link
  devwf share revoke --orphans [--dry-run]     Revoke every orphan link
  devwf drop --session <key> --reason <r> [--dry-run]
                                               Drop a task without completing it
  devwf complete --session <key> [--next-steps <s>]... [--dry-run]
                                               Complete a task whose DoD is proven
  devwf --help | --version

Environment:
  DEVWF_MONITOR_URL     Base URL of the central monitor (required)
  DEVWF_MONITOR_TOKEN   Write token for the monitor (required for writes)

Rules:
  --session is mandatory for every command that changes anything. There is no
  "current session" default, so a missing target is always a refusal.
  --dry-run prints what would change and writes nothing.
  No command ever signals a process. close only marks the session closed.

Exit codes:
  0 success   1 refusal or failure
`;

const FLAGS_WITH_VALUE = new Set([
  "--session",
  "--reason",
  "--token",
  "--next-steps",
  "--url",
]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--orphans", "--help", "--version", "--json"]);

/**
 * Parses argv (without the node and script entries).
 *
 * A repeated value flag keeps the LAST value: repeating a flag is usually a
 * shell history accident, and silently preferring the first one would make the
 * command act on a target the user did not mean most recently.
 */
export function parseArgs(argv = []) {
  const words = argv.filter((word) => typeof word === "string");

  if (words.length === 0) return { command: "help" };
  if (words[0] === "--help" || words[0] === "-h") return { command: "help" };
  if (words[0] === "--version" || words[0] === "-v") return { command: "version" };

  const command = words[0];
  if (!COMMANDS.includes(command)) {
    throw new CliError(
      `Unknown command "${command}". Valid commands: list, close, share, drop, complete. Run "devwf --help".`
    );
  }

  const args = { command, dryRun: false, nextSteps: [], json: false };

  // `share` takes one nested verb: list or revoke.
  let index = 1;
  if (command === "share") {
    const verb = words[1];
    if (verb !== "list" && verb !== "revoke") {
      throw new CliError(
        `"share" needs a verb: "devwf share list" or "devwf share revoke --token <t>".`
      );
    }
    args.shareVerb = verb;
    index = 2;
  }

  for (; index < words.length; index += 1) {
    const word = words[index];

    if (BOOLEAN_FLAGS.has(word)) {
      if (word === "--help") return { command: "help" };
      if (word === "--version") return { command: "version" };
      if (word === "--dry-run") args.dryRun = true;
      if (word === "--orphans") args.orphans = true;
      if (word === "--json") args.json = true;
      continue;
    }

    if (FLAGS_WITH_VALUE.has(word)) {
      const value = words[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new CliError(`${word} needs a value. Run "devwf --help".`);
      }
      index += 1;
      if (word === "--session") args.session = value;
      else if (word === "--reason") args.reason = value;
      else if (word === "--token") args.token = value;
      else if (word === "--url") args.url = value;
      else if (word === "--next-steps") args.nextSteps.push(value);
      continue;
    }

    throw new CliError(`Unknown option "${word}". Run "devwf --help".`);
  }

  if (args.nextSteps.length === 0) delete args.nextSteps;
  return args;
}
