import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../cli/commands.js";
import { parseArgs, CliError } from "../cli/args.js";

/**
 * `devwf checkpoint` is the controller-compatible checkpoint.
 *
 * The restart controller treats exit 0 as permission to stop a process, so this
 * command may only succeed when the write was read back and matched. A handler
 * that returns ok but not confirmed is a claim, not proof.
 */

function makeOut() {
  const lines = [];
  return { lines, write: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function fakeSessions() {
  return {
    find: (key) => ({
      sessionKey: key,
      file: `/tmp/${key}.json`,
      state: { taskDescription: "checkpoint me" },
    }),
    list: () => [],
  };
}

async function run(argv, { confirmed = true, text = "Checkpoint confirmed." } = {}) {
  const out = makeOut();
  const calls = [];
  const handlers = {
    checkpoint: async (args) => {
      calls.push(args);
      return { text, confirmed, settled: false };
    },
  };
  const result = await runCommand({
    args: parseArgs(argv),
    env: { DEVWF_STATE_ROOT: "/tmp/projects" },
    out,
    monitor: null,
    sessions: fakeSessions(),
    handlers,
  });
  return { result, out, calls };
}

test("checkpoint without --session is refused before any state is read", async () => {
  await assert.rejects(
    () => run(["checkpoint"]),
    (error) => error instanceof CliError && /--session/.test(error.message),
  );
});

test("a confirmed checkpoint exits successfully", async () => {
  const { result, out, calls } = await run(["checkpoint", "--session", "ses_a"]);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, "ses_a");
  assert.match(out.text(), /Checkpoint confirmed/);
});

test("a checkpoint that is written but not confirmed fails the command", async () => {
  // ok:true but confirmed:false is exactly the case that must not be read as
  // permission to stop a process.
  await assert.rejects(
    () => run(["checkpoint", "--session", "ses_a"], { confirmed: false, text: "written but not read back" }),
    (error) => error instanceof CliError && /not confirmed/.test(error.message),
  );
});

test("--summary reaches the handler", async () => {
  const { calls } = await run(["checkpoint", "--session", "ses_a", "--summary", "before restart"]);
  assert.equal(calls[0].summary, "before restart");
});

test("a dry run writes nothing and still exits successfully", async () => {
  const { result, out, calls } = await run(["checkpoint", "--session", "ses_a", "--dry-run"]);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(calls.length, 0, "dry run must not touch the handler");
  assert.match(out.text(), /would checkpoint/);
});

test("the usage text documents the checkpoint command", async () => {
  const { USAGE } = await import("../cli/args.js");
  assert.match(USAGE, /devwf checkpoint --session <key>/);
  assert.match(USAGE, /verify a task checkpoint before a restart/);
});
