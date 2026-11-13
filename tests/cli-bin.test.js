import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const CLI = path.join(process.cwd(), "bin", "cli.js");

/** Runs the real CLI with a deliberately empty environment. */
async function cli(args, env = {}) {
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: cleanEnv });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("--version prints the package version and exits 0", async () => {
  const { code, stdout } = await cli(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout, /^devwf \d+\.\d+\.\d+/);
});

test("--help documents the subcommands and both environment variables", async () => {
  const { code, stdout } = await cli(["--help"]);
  assert.equal(code, 0);
  for (const word of ["close", "drop", "complete", "share", "list"]) {
    assert.match(stdout, new RegExp(word));
  }
  assert.match(stdout, /DEVWF_MONITOR_URL/);
  assert.match(stdout, /DEVWF_MONITOR_TOKEN/);
});

test("a missing --session is reported before any configuration error", async () => {
  const { code, stderr } = await cli(["close"]);
  assert.equal(code, 1);
  assert.match(stderr, /--session/);
  // The argument mistake must win over the missing environment.
  assert.doesNotMatch(stderr, /DEVWF_MONITOR_URL/);
});

test("a missing monitor URL is refused and named", async () => {
  const { code, stderr } = await cli(["list"]);
  assert.equal(code, 1);
  assert.match(stderr, /DEVWF_MONITOR_URL/);
});

test("a missing monitor token is refused and named", async () => {
  const { code, stderr } = await cli(["list"], { DEVWF_MONITOR_URL: "http://127.0.0.1:9" });
  assert.equal(code, 1);
  assert.match(stderr, /DEVWF_MONITOR_TOKEN/);
});

test("an unknown subcommand is refused", async () => {
  const { code, stderr } = await cli(["kil"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
});

test("--dry-run on close sends no request and reports the intent", async () => {
  const { code, stdout } = await cli(
    ["close", "--session", "ses_x", "--dry-run"],
    { DEVWF_MONITOR_URL: "http://127.0.0.1:9", DEVWF_MONITOR_TOKEN: "t" }
  );
  assert.equal(code, 0);
  assert.match(stdout, /DRY RUN/);
  assert.match(stdout, /ses_x/);
  assert.match(stdout, /Nothing was changed/);
});

test("drop refuses a missing reason before reading any state", async () => {
  const { code, stderr } = await cli(
    ["drop", "--session", "ses_x"],
    { DEVWF_STATE_ROOT: "/tmp/devwf-cli-no-such-root" }
  );
  assert.equal(code, 1);
  assert.match(stderr, /--reason/);
  assert.doesNotMatch(stderr, /projects/);
});
