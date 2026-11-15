import test from "node:test";
import assert from "node:assert/strict";

import {
  createLocalAdapters,
  createMacAdapters,
  createWindowsAdapters,
} from "../session-controller-adapters.js";

test("Windows processInfo reads identity from PowerShell CIM", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "powershell");
    assert.ok(args.join(" ").includes("ProcessId=123"));
    return JSON.stringify({
      ProcessId: 123,
      CreationDate: "2026-11-15T08:00:00.000Z",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    });
  };
  const adapters = createWindowsAdapters({ exec, isAlive: () => true });
  const info = adapters.processInfo(123);
  assert.equal(info.pid, 123);
  assert.match(info.startedAt, /2026-11-15T08:00:00/);
  assert.match(info.executable, /node\.exe$/);
});

test("Windows processInfo falls back to wmic when CIM returns nothing", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(cmd);
    if (cmd === "powershell") return "";
    assert.equal(cmd, "wmic");
    assert.ok(args.includes("processid=123"));
    return "CreationDate=20261115080000.000000+420\r\r\nExecutablePath=C:\\Program Files\\nodejs\\node.exe\r\r\n";
  };
  const adapters = createWindowsAdapters({ exec, isAlive: () => true });
  const info = adapters.processInfo(123);
  assert.deepEqual(calls, ["powershell", "wmic"]);
  assert.match(info.startedAt, /20261115080000/);
  assert.match(info.executable, /node\.exe$/);
});

test("Windows processInfo returns null when the process is gone", () => {
  const exec = (cmd) => {
    if (cmd === "powershell") return "";
    throw new Error("No Instance(s) Available.");
  };
  const adapters = createWindowsAdapters({ exec, isAlive: () => false });
  assert.equal(adapters.processInfo(999999), null);
});

test("Windows requestStop calls taskkill for the exact PID", () => {
  let seen = null;
  const exec = (cmd, args) => {
    seen = { cmd, args };
    return "";
  };
  const adapters = createWindowsAdapters({ exec, isAlive: () => true });
  assert.equal(adapters.requestStop(456).ok, true);
  assert.equal(seen.cmd, "taskkill");
  assert.deepEqual(seen.args, ["/PID", "456"]);
});

test("macOS processInfo parses ps start time and executable", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "ps");
    if (args.includes("lstart=")) return "Sat Nov 15 08:00:00 2026\n";
    return "/usr/local/bin/node\n";
  };
  const adapters = createMacAdapters({ exec, isAlive: () => true });
  const info = adapters.processInfo(789);
  assert.equal(info.pid, 789);
  assert.match(info.startedAt, /Nov 15/);
  assert.match(info.executable, /node$/);
});

test("macOS requestStop sends SIGTERM", () => {
  const original = process.kill;
  let seen = null;
  process.kill = (pid, signal) => {
    seen = { pid, signal };
    return true;
  };
  try {
    const adapters = createMacAdapters({ exec: () => "", isAlive: () => true });
    assert.equal(adapters.requestStop(321).ok, true);
    assert.deepEqual(seen, { pid: 321, signal: "SIGTERM" });
  } finally {
    process.kill = original;
  }
});

test("waitForExit returns ok when the process is gone", async () => {
  const adapters = createMacAdapters({ exec: () => "", isAlive: () => false });
  const result = await adapters.waitForExit(1, { attempts: 2, delayMs: 1 });
  assert.equal(result.ok, true);
});

test("waitForExit reports PROCESS_DID_NOT_EXIT when the process stays alive", async () => {
  const adapters = createMacAdapters({ exec: () => "", isAlive: () => true });
  const result = await adapters.waitForExit(1, { attempts: 2, delayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROCESS_DID_NOT_EXIT");
});

test("createLocalAdapters selects the platform adapter", () => {
  const win = createLocalAdapters({ platform: "win32", exec: () => "", isAlive: () => true });
  const mac = createLocalAdapters({ platform: "darwin", exec: () => "", isAlive: () => true });
  assert.equal(typeof win.processInfo, "function");
  assert.equal(typeof mac.processInfo, "function");
});
