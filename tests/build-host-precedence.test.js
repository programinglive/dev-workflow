import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleReportBuildStatus,
  handleRunTests,
} from "../tools/handler-modules/workflow-handlers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeState(overrides = {}) {
  return {
    state: {
      machine: "HELLOWORLD",
      activeBuild: null,
      buildHistory: [],
      bugFixed: true,
      testsCreated: true,
      ...overrides,
    },
    _sessionKey: () => "ses_test",
    async save() {},
  };
}

function withBuildHostEnv(value, run) {
  const previous = process.env.DEVWF_BUILD_HOST;
  if (value === undefined) {
    delete process.env.DEVWF_BUILD_HOST;
  } else {
    process.env.DEVWF_BUILD_HOST = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.DEVWF_BUILD_HOST;
    } else {
      process.env.DEVWF_BUILD_HOST = previous;
    }
  }
}

test("run_tests prefers an explicit buildHost over the session machine", async () => {
  const state = fakeState();
  await handleRunTests(
    { passed: true, testCommand: "npm test", buildHost: "bw-tools" },
    state,
  );
  assert.equal(state.state.activeBuild.buildHost, "bw-tools");
});

test("run_tests prefers DEVWF_BUILD_HOST over the session machine", async () => {
  await withBuildHostEnv("bw-tools", async () => {
    const state = fakeState();
    await handleRunTests({ passed: true, testCommand: "npm test" }, state);
    assert.equal(state.state.activeBuild.buildHost, "bw-tools");
  });
});

test("run_tests falls back to the session machine when nothing else is set", async () => {
  await withBuildHostEnv(undefined, async () => {
    const state = fakeState();
    await handleRunTests({ passed: true, testCommand: "npm test" }, state);
    assert.equal(state.state.activeBuild.buildHost, "HELLOWORLD");
  });
});

test("report_build_status prefers DEVWF_BUILD_HOST over the session machine", async () => {
  await withBuildHostEnv("bw-tools", async () => {
    const state = fakeState();
    await handleReportBuildStatus(
      { status: "building", target: "Paratest Suite" },
      state,
    );
    assert.equal(state.state.activeBuild.buildHost, "bw-tools");
  });
});

test("report_build_status keeps an explicit buildHost", async () => {
  await withBuildHostEnv("bw-tools", async () => {
    const state = fakeState();
    await handleReportBuildStatus(
      { status: "building", target: "Paratest Suite", buildHost: "builder-vm" },
      state,
    );
    assert.equal(state.state.activeBuild.buildHost, "builder-vm");
  });
});

test("managed launcher defaults DEVWF_BUILD_HOST to build-host.example", async () => {
  // Behavioural, not a source regex: the launcher must hand the child a
  // build-host default, and must still honour an explicit value.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { launchManaged } = require("../managed/launcher.cjs");
  const os = await import("node:os");
  const fs = await import("node:fs/promises");

  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devwf-buildhost-"));
  try {
    const captured = [];
    const spawnImpl = (_exec, _args, options) => {
      captured.push(options.env);
      return { on() {}, kill() {} };
    };
    const release = { revision: "d".repeat(40), version: "1.2.3", runtimeRoot: cacheRoot, offline: false };

    await launchManaged({
      env: {},
      cacheRoot,
      now: () => Date.now(),
      resolveReleaseImpl: async () => release,
      spawnImpl,
    });
    assert.equal(captured[0].DEVWF_BUILD_HOST, "build-host.example");
    assert.equal(captured[0].DEVWF_RELEASE_VERSION, "1.2.3");

    await launchManaged({
      env: { DEVWF_BUILD_HOST: "builder-vm" },
      cacheRoot,
      now: () => Date.now(),
      resolveReleaseImpl: async () => release,
      spawnImpl,
    });
    assert.equal(captured[1].DEVWF_BUILD_HOST, "builder-vm");
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run_tests exposes buildHost in its tool schema", () => {
  const source = readFileSync(path.join(ROOT, "tools/definitions.js"), "utf8");
  const runTests = source.slice(source.indexOf('name: "run_tests"'));
  assert.match(runTests.slice(0, 1200), /buildHost:/);
});
