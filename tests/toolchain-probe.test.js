import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_TOOLS,
  compareToolchainToManifest,
  createToolchainProbe,
  detectToolchain,
  loadFleetManifest,
  resolveExecutable,
} from "../toolchain.js";

/**
 * WHY THIS FILE EXISTS (16 November 2026)
 * ---------------------------------------
 * The fleet panel showed "npm: Missing" and "gcloud: Missing" on both Windows
 * machines while both tools were installed and ran fine from a terminal. The
 * probe built a shell string with every token double-quoted, and on Windows the
 * command name is executed as a batch shim: `"npm" --version` makes `%0` be
 * `"npm"`, so `%~dp0` inside npm.cmd resolves to the CURRENT DIRECTORY instead
 * of the shim's own folder and node cannot find npm-cli.js. Reproduced by hand:
 *
 *   cmd /c "\"npm\" \"--version\""     -> Cannot find module '...\node_modules\npm\bin\npm-prefix.js'
 *   cmd /c "npm --version"             -> 11.19.0
 *   cmd /c "\"gcloud\" \"--version\""  -> can't open file '...\..\lib\gcloud.py'
 *   cmd /c "gcloud --version"          -> Google Cloud SDK 569.0.0
 *
 * A missing tool is a real fact worth showing. A tool that is present and
 * called "missing" teaches the reader to distrust the whole panel, so the probe
 * must resolve the real executable and pass arguments as an array - never a
 * quoted shell string.
 */

const WIN_PATH = ["C:\\Program Files\\nodejs", "C:\\Users\\dev\\AppData\\Roaming\\npm"].join(";");

function fakeFiles(list) {
  const set = new Set(list.map((p) => p.toLowerCase()));
  return (candidate) => set.has(String(candidate).toLowerCase());
}

test("windows resolution finds the .cmd shim that actually exists", () => {
  const resolved = resolveExecutable("npm", {
    platform: "win32",
    env: { PATH: WIN_PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    isFile: fakeFiles(["C:\\Program Files\\nodejs\\npm.cmd"]),
  });
  // Windows is case-insensitive, and PATHEXT usually arrives upper-case, so the
  // extension keeps whatever casing the environment declared.
  assert.equal(resolved.toLowerCase(), "c:\\program files\\nodejs\\npm.cmd");
});

test("windows resolution follows PATHEXT order instead of guessing", () => {
  const resolved = resolveExecutable("gh", {
    platform: "win32",
    env: { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    isFile: fakeFiles(["C:\\tools\\gh.exe", "C:\\tools\\gh.cmd"]),
  });
  assert.equal(resolved.toLowerCase(), "c:\\tools\\gh.exe");
});

test("a tool that is nowhere on PATH resolves to null, not to a guess", () => {
  const resolved = resolveExecutable("gcloud", {
    platform: "win32",
    env: { PATH: WIN_PATH, PATHEXT: ".EXE;.CMD" },
    isFile: fakeFiles([]),
  });
  assert.equal(resolved, null);
});

test("a tool name carrying a path separator is refused", () => {
  // The probe list is fixed today, but a resolver that accepts `..\evil` is a
  // PATH-injection hole the moment a caller passes anything else.
  const isFile = () => true;
  assert.equal(resolveExecutable("..\\evil", { platform: "win32", env: { PATH: "C:\\x" }, isFile }), null);
  assert.equal(resolveExecutable("bin/evil", { platform: "linux", env: { PATH: "/usr/bin" }, isFile }), null);
});

test("posix resolution splits PATH on a colon and ignores PATHEXT", () => {
  const resolved = resolveExecutable("glab", {
    platform: "darwin",
    env: { PATH: "/usr/local/bin:/usr/bin", PATHEXT: ".EXE" },
    isFile: fakeFiles(["/usr/local/bin/glab"]),
  });
  assert.equal(resolved, "/usr/local/bin/glab");
});

test("a batch shim is run through cmd with its absolute path as one quoted token", async () => {
  // Node refuses to spawn a .cmd/.bat without a shell, and cmd is also the only
  // thing that can run one. The absolute path is what makes %~dp0 inside the
  // shim resolve to the shim's own folder; quoting a BARE name is what broke it.
  const calls = [];
  const probe = createToolchainProbe({
    exec: async (command, options) => {
      calls.push({ command, options });
      return { stdout: "11.19.0" };
    },
    resolve: () => "C:\\Program Files\\nodejs\\npm.cmd",
    platform: "win32",
  });

  const stdout = await probe("npm", ["--version"]);

  assert.equal(stdout, "11.19.0");
  assert.equal(calls[0].command, '"C:\\Program Files\\nodejs\\npm.cmd" "--version"');
  assert.equal(calls[0].options.executable, undefined, "a batch shim must go through the shell");
});

test("a native executable is run without a shell and without quoting", async () => {
  const calls = [];
  const probe = createToolchainProbe({
    exec: async (command, options) => {
      calls.push({ command, options });
      return { stdout: "2.103.3" };
    },
    resolve: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
    platform: "win32",
  });

  const stdout = await probe("gh", ["--version"]);

  assert.equal(stdout, "2.103.3");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.executable, "C:\\Program Files\\GitHub CLI\\gh.exe");
  assert.deepEqual(calls[0].options.arguments, ["--version"]);
  // The regression guard: no shell quoting of the command name, ever.
  assert.ok(!String(calls[0].command).includes('"'), "a native executable needs no shell quoting");
});

test("an unresolved tool is reported as missing and never as a version", async () => {
  const probe = createToolchainProbe({
    exec: async () => {
      throw new Error("must not run an unresolved tool");
    },
    resolve: () => null,
  });

  const detected = await detectToolchain({ run: probe });
  for (const tool of REQUIRED_TOOLS) assert.equal(detected[tool], null, tool);
});

test("the doctor compares each tool against the pinned fleet manifest", () => {
  const manifest = { tools: { gh: "2.103.3", npm: "11.19.1", gcloud: "590.0.0" } };
  const report = compareToolchainToManifest(manifest, { gh: "2.103.3", npm: null, gcloud: "569.0.0" });

  assert.deepEqual(report.rows.find((r) => r.tool === "gh"), { tool: "gh", pinned: "2.103.3", actual: "2.103.3", status: "ok" });
  assert.equal(report.rows.find((r) => r.tool === "npm").status, "missing");
  assert.equal(report.rows.find((r) => r.tool === "gcloud").status, "drift");
  assert.deepEqual([...report.mismatched].sort(), ["gcloud", "npm"]);
  assert.equal(report.inSync, false);
});

test("the shipped manifest pins a version for every required tool", () => {
  const manifest = loadFleetManifest();
  assert.ok(manifest, "the fleet manifest must exist");
  assert.equal(manifest.schemaVersion, 1);
  for (const tool of REQUIRED_TOOLS) {
    assert.match(String(manifest.tools[tool]), /^\d+\.\d+\.\d+$/, `${tool} must be pinned to a concrete version`);
  }
  assert.match(String(manifest.managedMcp.version), /^\d+\.\d+\.\d+$/);
  assert.match(String(manifest.managedMcp.revision), /^[0-9a-f]{40}$/);
});
