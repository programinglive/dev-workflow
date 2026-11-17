import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  worktreeMutexEndpoint,
  clearHeldLeasesForTests,
  UNVERIFIED_MUTEX_OPT_IN_ENV,
  UNVERIFIED_MUTEX_SOCKET_DIR_ENV,
  UNVERIFIED_MUTEX_WARNING,
} from "../process-lock.js";

/**
 * Explicit opt-in for the unverified kernel mutex on macOS.
 *
 * WHY THIS EXISTS
 * ---------------
 * The OS-owned kernel mutex has no natively verified implementation on
 * macOS: Linux has abstract unix sockets, Windows has named pipes, and
 * macOS has neither. The endpoint therefore fails closed on darwin, which
 * blocks every workflow write on a Mac, and a Mac that cannot write state
 * never reports to the central monitor.
 *
 * WHAT THIS GUARDS
 * ----------------
 * The default stays fail-closed. Only the exact value "1" in
 * DEVWF_ALLOW_UNVERIFIED_MUTEX activates the darwin path, and activation
 * prints a warning once per process so the operator always knows the
 * mutex is not natively verified on this platform.
 *
 * The darwin endpoint is a unix domain socket file whose name carries the
 * full 32 hex characters of the worktree digest, so two different
 * worktrees can never collide on one endpoint.
 */

function gitInit(dir) {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
}

async function createRepo(base, name) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  gitInit(dir);
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function withTempWorkspace(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "darwin-optin-"));
  try {
    return await fn(base);
  } finally {
    clearHeldLeasesForTests();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

test("darwin without the opt-in environment variable keeps failing closed", () => {
  const endpoint = worktreeMutexEndpoint("/tmp/example-worktree", "darwin", {});
  assert.equal(endpoint.supported, false);
  assert.equal(endpoint.error, "PLATFORM_UNSUPPORTED_KERNEL_MUTEX");
  assert.equal(endpoint.platform, "darwin");
});

test("darwin with DEVWF_ALLOW_UNVERIFIED_MUTEX=1 reports a supported unverified endpoint", () => {
  const endpoint = worktreeMutexEndpoint("/tmp/example-worktree", "darwin", {
    [UNVERIFIED_MUTEX_OPT_IN_ENV]: "1",
  });
  assert.equal(endpoint.supported, true);
  assert.equal(endpoint.platform, "darwin");
  assert.equal(endpoint.unverified, true);
  assert.equal(endpoint.exclusive, true);
  assert.ok(endpoint.path.endsWith(".sock"), `expected a unix socket path, got ${endpoint.path}`);
  assert.ok(
    endpoint.path.includes("devwf-wt-"),
    `expected the endpoint name to carry the worktree digest, got ${endpoint.path}`,
  );
});

test("win32 and linux endpoints are unchanged by the opt-in environment variable", () => {
  const withoutOptIn = {
    win32: worktreeMutexEndpoint("/tmp/example-worktree", "win32", {}),
    linux: worktreeMutexEndpoint("/tmp/example-worktree", "linux", {}),
  };
  const withOptIn = {
    win32: worktreeMutexEndpoint("/tmp/example-worktree", "win32", {
      [UNVERIFIED_MUTEX_OPT_IN_ENV]: "1",
    }),
    linux: worktreeMutexEndpoint("/tmp/example-worktree", "linux", {
      [UNVERIFIED_MUTEX_OPT_IN_ENV]: "1",
    }),
  };

  assert.deepEqual(withOptIn.win32, withoutOptIn.win32);
  assert.deepEqual(withOptIn.linux, withoutOptIn.linux);
  assert.equal(withoutOptIn.win32.supported, true);
  assert.equal(withoutOptIn.linux.supported, true);
  assert.equal(withoutOptIn.win32.unverified, undefined);
  assert.equal(withoutOptIn.linux.unverified, undefined);
});

test("an opt-in value other than 1 does not activate the darwin mutex", () => {
  for (const value of ["", "0", "true", "yes", "on", "11"]) {
    const endpoint = worktreeMutexEndpoint("/tmp/example-worktree", "darwin", {
      [UNVERIFIED_MUTEX_OPT_IN_ENV]: value,
    });
    assert.equal(endpoint.supported, false, `value ${JSON.stringify(value)} must not activate the mutex`);
    assert.equal(endpoint.error, "PLATFORM_UNSUPPORTED_KERNEL_MUTEX");
  }
});

test("the darwin mutex is acquired and released when the opt-in is enabled", async () => {
  await withTempWorkspace(async (base) => {
    const repo = await createRepo(base, "darwin-optin-repo");
    // The unix socket address has to stay inside the platform limit, so the
    // socket directory is deliberately short instead of the long temporary
    // directory this test runs in.
    const socketDir = await mkdtemp("/tmp/devwf-");
    const env = {
      [UNVERIFIED_MUTEX_OPT_IN_ENV]: "1",
      [UNVERIFIED_MUTEX_SOCKET_DIR_ENV]: socketDir,
    };

    try {
      const acquired = await acquireWorktreeMutex({ projectDir: repo, platform: "darwin", env });
      assert.equal(acquired.ok, true, `expected acquisition to succeed, got ${JSON.stringify(acquired)}`);
      assert.notEqual(acquired.supported, false);
      assert.ok(acquired.endpoint.endsWith(".sock"), `expected a unix socket endpoint, got ${acquired.endpoint}`);
      assert.equal(acquired.capability.active, true);

      const released = await releaseWorktreeMutex(acquired.capability);
      assert.equal(released, true);
      assert.equal(acquired.capability.active, false);
    } finally {
      await rm(socketDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  });
});

test("the opt-in warning names the environment variable that enabled it", () => {
  assert.ok(
    UNVERIFIED_MUTEX_WARNING.includes(UNVERIFIED_MUTEX_OPT_IN_ENV),
    `the warning must name ${UNVERIFIED_MUTEX_OPT_IN_ENV}`,
  );
});
