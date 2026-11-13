import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../cli/commands.js";
import { parseArgs, CliError } from "../cli/args.js";

/** Records what the command layer printed, so output is asserted not assumed. */
function makeOut() {
  const lines = [];
  return { lines, write: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

/** A monitor stub in the same shape as the real client. */
function fakeMonitor(overrides = {}) {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push({ name, args });
    return { ok: true };
  };
  return {
    calls,
    closeSession: async (args) => {
      calls.push({ name: "closeSession", args });
      return overrides.closeSession ?? { ok: true, closed: true };
    },
    revokeShare: record("revokeShare"),
    revokeOrphans: record("revokeOrphans"),
    listShares: async () => overrides.listShares ?? { ok: true, links: [] },
    listSessions: async () => overrides.listSessions ?? { ok: true, sessions: [] },
  };
}

/** A session store stub with one known session. */
function fakeSessions({ found = true } = {}) {
  const calls = [];
  return {
    calls,
    find: (key) => {
      calls.push({ name: "find", key });
      if (!found) throw new CliError(`Unknown session "${key}".`);
      return {
        key,
        user: "user-1",
        project: "demo-abc123",
        file: `/tmp/projects/demo-abc123/users/user-1/workflow-state.${key}.json`,
        state: { currentPhase: "coding", taskDescription: "stale card" },
      };
    },
    list: () => [
      { key: "ses_a", project: "demo", user: "u", phase: "coding", taskDescription: "first" },
    ],
  };
}

function fakeHandlers() {
  const calls = [];
  return {
    calls,
    drop: async (args) => {
      calls.push({ name: "drop", args });
      return { text: "⚠️ Task dropped." };
    },
    complete: async (args) => {
      calls.push({ name: "complete", args });
      return { text: "✅ Task completed." };
    },
  };
}

async function base(argv, overrides = {}) {
  const out = makeOut();
  const monitor = overrides.monitor ?? fakeMonitor();
  const sessions = overrides.sessions ?? fakeSessions();
  const handlers = overrides.handlers ?? fakeHandlers();
  const result = await runCommand({
    args: parseArgs(argv),
    env: { DEVWF_STATE_ROOT: "/tmp/projects" },
    out,
    monitor,
    sessions,
    handlers,
  });
  return { result, out, monitor, sessions, handlers };
}

test("close without --session is refused before any HTTP call", async () => {
  const out = makeOut();
  const monitor = fakeMonitor();
  await assert.rejects(
    () =>
      runCommand({
        args: parseArgs(["close"]),
        env: {},
        out,
        monitor,
        sessions: fakeSessions(),
        handlers: fakeHandlers(),
      }),
    (error) => error instanceof CliError && /--session/.test(error.message)
  );
  assert.equal(monitor.calls.length, 0);
});

test("drop without --reason is refused before loading any state", async () => {
  const sessions = fakeSessions();
  await assert.rejects(
    () => base(["drop", "--session", "ses_a"]),
    (error) => error instanceof CliError && /--reason/.test(error.message)
  );
  assert.equal(sessions.calls.length, 0);
});

test("drop on an unknown session is refused and never calls the handler", async () => {
  const handlers = fakeHandlers();
  await assert.rejects(
    () => base(["drop", "--session", "ses_missing", "--reason", "stale"], { sessions: fakeSessions({ found: false }), handlers }),
    (error) => error instanceof CliError && /unknown session/i.test(error.message)
  );
  assert.equal(handlers.calls.length, 0);
});

test("close --dry-run sends nothing and says what would change", async () => {
  const { out, monitor } = await base(["close", "--session", "ses_a", "--dry-run"]);
  assert.equal(monitor.calls.length, 0);
  assert.match(out.text(), /would/i);
  assert.match(out.text(), /ses_a/);
});

test("drop --dry-run sends nothing and never runs the handler", async () => {
  const handlers = fakeHandlers();
  const { out } = await base(["drop", "--session", "ses_a", "--reason", "stale", "--dry-run"], { handlers });
  assert.equal(handlers.calls.length, 0);
  assert.match(out.text(), /would/i);
});

test("share revoke --dry-run sends nothing", async () => {
  const { monitor, out } = await base(["share", "revoke", "--token", "tok", "--dry-run"]);
  assert.equal(monitor.calls.length, 0);
  assert.match(out.text(), /tok/);
});

test("close with a real target calls the monitor once with the session key", async () => {
  const { monitor, result } = await base(["close", "--session", "ses_a"]);
  assert.equal(monitor.calls.length, 1);
  assert.equal(monitor.calls[0].name, "closeSession");
  assert.equal(monitor.calls[0].args.sessionKey, "ses_a");
  assert.equal(result.ok, true);
});

test("drop runs the existing handler with the reason from the CLI", async () => {
  const handlers = fakeHandlers();
  const { result } = await base(["drop", "--session", "ses_a", "--reason", "card is stale"], { handlers });
  assert.equal(handlers.calls.length, 1);
  assert.equal(handlers.calls[0].name, "drop");
  assert.equal(handlers.calls[0].args.reason, "card is stale");
  assert.equal(result.ok, true);
});

test("complete forwards repeatable next steps to the handler", async () => {
  const handlers = fakeHandlers();
  await base(
    ["complete", "--session", "ses_a", "--next-steps", "fix retry", "--next-steps", "add tests"],
    { handlers }
  );
  assert.deepEqual(handlers.calls[0].args.nextSteps, ["fix retry", "add tests"]);
});

test("a handler refusal is surfaced and turns into a failure", async () => {
  const handlers = {
    drop: async () => ({ response: { text: "⚠️ Task dropped." } }),
    complete: async () => ({
      response: { text: "⚠️ 3 Definition of Done items are still open." },
      settled: false,
    }),
  };
  await assert.rejects(
    () => base(["complete", "--session", "ses_a"], { handlers }),
    (error) => error instanceof CliError && /was refused/i.test(error.message)
  );
});

test("a settled handler reports success and prints its response text", async () => {
  const handlers = {
    drop: async () => ({ response: { content: [{ type: "text", text: "⚠️ Task dropped." }] }, settled: true }),
    complete: async () => ({ response: { content: [{ type: "text", text: "✅ Task completed!" }] }, settled: true }),
  };
  const { out, result } = await base(["complete", "--session", "ses_a"], { handlers });
  assert.equal(result.ok, true);
  assert.match(out.text(), /Task completed/);
});

test("share revoke sends the token when not a dry run", async () => {
  const { monitor } = await base(["share", "revoke", "--token", "tok-1"]);
  assert.equal(monitor.calls[0].name, "revokeShare");
  assert.equal(monitor.calls[0].args.token, "tok-1");
});

test("share revoke --orphans calls the orphan sweep", async () => {
  const { monitor } = await base(["share", "revoke", "--orphans"]);
  assert.equal(monitor.calls[0].name, "revokeOrphans");
});

test("share revoke with neither token nor --orphans is refused", async () => {
  await assert.rejects(
    () => base(["share", "revoke"]),
    (error) => error instanceof CliError && /--token|--orphans/.test(error.message)
  );
});

test("list reads the monitor and prints one line per session", async () => {
  const monitor = fakeMonitor({
    listSessions: {
      ok: true,
      sessions: [
        { sessionKey: "ses_a", machine: "Mac", projectName: "demo", phase: "coding" },
      ],
    },
  });
  const { out, result } = await base(["list"], { monitor });
  assert.equal(result.ok, true);
  assert.match(out.text(), /ses_a/);
  assert.match(out.text(), /Mac/);
});

test("doctor runs environment health check and outputs status", async () => {
  const { out, result } = await base(["doctor"]);
  assert.equal(result.ok, true);
  assert.match(out.text(), /DevWorkflow Environment Doctor/);
  assert.match(out.text(), /Node\.js/);
  assert.match(out.text(), /better-sqlite3/);
});

test("every success result carries ok true so the exit code can trust it", async () => {
  for (const argv of [
    ["close", "--session", "ses_a"],
    ["share", "revoke", "--token", "t"],
    ["drop", "--session", "ses_a", "--reason", "r"],
    ["complete", "--session", "ses_a"],
  ]) {
    const { result } = await base(argv);
    assert.equal(result.ok, true, `expected ok for ${argv.join(" ")}`);
  }
});
