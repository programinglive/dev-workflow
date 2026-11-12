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

test("managed launcher defaults DEVWF_BUILD_HOST to bw-tools", () => {
  const source = readFileSync(path.join(ROOT, "managed/launcher.cjs"), "utf8");
  assert.match(
    source,
    /DEVWF_BUILD_HOST:process\.env\.DEVWF_BUILD_HOST\|\|'bw-tools'/,
  );
});

test("run_tests exposes buildHost in its tool schema", () => {
  const source = readFileSync(path.join(ROOT, "tools/definitions.js"), "utf8");
  const runTests = source.slice(source.indexOf('name: "run_tests"'));
  assert.match(runTests.slice(0, 1200), /buildHost:/);
});
