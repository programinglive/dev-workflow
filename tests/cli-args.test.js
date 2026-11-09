import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, CliError, USAGE } from "../cli/args.js";

test("close accepts an explicit session key", () => {
  const args = parseArgs(["close", "--session", "ses_abc"]);
  assert.equal(args.command, "close");
  assert.equal(args.session, "ses_abc");
  assert.equal(args.dryRun, false);
});

test("drop carries both the session and the reason", () => {
  const args = parseArgs(["drop", "--session", "ses_abc", "--reason", "stale card"]);
  assert.equal(args.command, "drop");
  assert.equal(args.session, "ses_abc");
  assert.equal(args.reason, "stale card");
});

test("no arguments asks for help", () => {
  assert.equal(parseArgs([]).command, "help");
});

test("--help and --version are recognised as commands", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["--version"]).command, "version");
});

test("--dry-run is opt-in and defaults to false", () => {
  assert.equal(parseArgs(["close", "--session", "s"]).dryRun, false);
  assert.equal(parseArgs(["close", "--session", "s", "--dry-run"]).dryRun, true);
});

test("an unknown flag is refused and the message names it", () => {
  assert.throws(
    () => parseArgs(["close", "--sessoin", "s"]),
    (error) => error instanceof CliError && /--sessoin/.test(error.message)
  );
});

test("an unknown subcommand is refused and lists the valid ones", () => {
  assert.throws(
    () => parseArgs(["kil"]),
    (error) =>
      error instanceof CliError &&
      /kil/.test(error.message) &&
      /close/.test(error.message) &&
      /drop/.test(error.message)
  );
});

test("a repeated flag keeps the last value instead of guessing", () => {
  const args = parseArgs(["close", "--session", "one", "--session", "two"]);
  assert.equal(args.session, "two");
});

test("share accepts a token or the orphans switch", () => {
  assert.equal(parseArgs(["share", "revoke", "--token", "tok"]).token, "tok");
  assert.equal(parseArgs(["share", "revoke", "--orphans"]).orphans, true);
  assert.equal(parseArgs(["share", "list"]).command, "share");
});

test("complete accepts repeatable next steps", () => {
  const args = parseArgs([
    "complete",
    "--session",
    "s",
    "--next-steps",
    "fix retry",
    "--next-steps",
    "add tests",
  ]);
  assert.deepEqual(args.nextSteps, ["fix retry", "add tests"]);
});

test("every CliError carries a non-zero exit code", () => {
  const error = new CliError("boom");
  assert.equal(error.exitCode, 1);
  assert.equal(error.name, "CliError");
});

test("the usage text documents all five subcommands and both env vars", () => {
  for (const word of ["close", "drop", "complete", "share", "list"]) {
    assert.match(USAGE, new RegExp(word));
  }
  assert.match(USAGE, /DEVWF_MONITOR_URL/);
  assert.match(USAGE, /DEVWF_MONITOR_TOKEN/);
});
