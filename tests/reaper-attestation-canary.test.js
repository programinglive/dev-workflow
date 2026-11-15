import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { createLocalAdapters } from "../session-controller-adapters.js";
import { verifyProcessIdentity } from "../session-reaper.js";

/**
 * The attestation canary must only ever act on its own fixture.
 *
 * These tests exercise the identity check the canary depends on, using a real
 * private child process, so a regression that made the canary touch a live
 * session would fail here first.
 */

const adapters = createLocalAdapters();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startFixture() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = adapters.processInfo(child.pid);
    if (info) return { child, info };
    await sleep(100);
  }
  throw new Error("fixture did not start");
}

async function stopFixture(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5000)]);
}

test("a live fixture is verified alive, so the canary never attests it", async () => {
  const { child, info } = await startFixture();
  try {
    const session = {
      session_key: "ses_canary",
      machine: "TESTHOST",
      updated_at: new Date().toISOString(),
      owner: { pid: info.pid, startedAt: info.startedAt, executable: info.executable },
    };
    const identity = verifyProcessIdentity(session, adapters);
    assert.equal(identity.ok, true, "a live fixture must verify as alive");
  } finally {
    await stopFixture(child);
  }
});

test("an absent fixture reports PROCESS_ABSENT, which is the only attestable state", async () => {
  const { child, info } = await startFixture();
  const session = {
    session_key: "ses_canary",
    machine: "TESTHOST",
    updated_at: new Date().toISOString(),
    owner: { pid: info.pid, startedAt: info.startedAt, executable: info.executable },
  };
  await stopFixture(child);

  const identity = verifyProcessIdentity(session, adapters);
  assert.equal(identity.ok, false);
  assert.equal(identity.code, "PROCESS_ABSENT");
});

test("a reused PID is not attestable", async () => {
  const { child, info } = await startFixture();
  try {
    const session = {
      session_key: "ses_canary",
      machine: "TESTHOST",
      updated_at: new Date().toISOString(),
      owner: { pid: info.pid, startedAt: "1999-01-01T00:00:00Z", executable: info.executable },
    };
    const identity = verifyProcessIdentity(session, adapters);
    assert.equal(identity.ok, false);
    assert.equal(identity.code, "PID_REUSED");
  } finally {
    await stopFixture(child);
  }
});
