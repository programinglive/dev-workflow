import { test } from "node:test";
import assert from "node:assert";

import {
  SUPERPOWERS_SPEC,
  resolveConfigDir,
  parseConfigPathOutput,
  fallbackConfigDir,
  mergePluginEntry,
  mergeMcpServer,
  ensureSchema,
  backupPathFor,
  smokeTestVerdict,
} from "../scripts/setup-stack.js";

// ---------------------------------------------------------------------------
// OpenCode V2 config location
// ---------------------------------------------------------------------------

test("parseConfigPathOutput reads the config path from `opencode debug paths`", () => {
  const stdout = [
    "home       C:\\Users\\<username>",
    "data       C:\\Users\\<username>\\.local\\share\\opencode",
    "cache      C:\\Users\\<username>\\.cache\\opencode",
    "config     C:\\Users\\<username>\\.config\\opencode",
    "state      C:\\Users\\<username>\\.local\\state\\opencode",
  ].join("\n");

  assert.strictEqual(parseConfigPathOutput(stdout), "C:\\Users\\<username>\\.config\\opencode");
});

test("parseConfigPathOutput returns null when no config line is present", () => {
  assert.strictEqual(parseConfigPathOutput("home   /home/dev\ndata   /home/dev/.local\n"), null);
  assert.strictEqual(parseConfigPathOutput(""), null);
  assert.strictEqual(parseConfigPathOutput(null), null);
});

test("resolveConfigDir prefers the path reported by OpenCode over any guess", () => {
  const resolved = resolveConfigDir({
    probe: () => "D:\\custom\\opencode",
    platform: "win32",
    home: "C:\\Users\\<username>",
    appData: "C:\\Users\\<username>\\AppData\\Roaming",
  });

  assert.strictEqual(resolved, "D:\\custom\\opencode");
});

test("resolveConfigDir falls back to ~/.config/opencode on Windows, not APPDATA", () => {
  const resolved = resolveConfigDir({
    probe: () => null,
    platform: "win32",
    home: "C:\\Users\\<username>",
    appData: "C:\\Users\\<username>\\AppData\\Roaming",
  });

  assert.strictEqual(resolved, "C:\\Users\\<username>\\.config\\opencode");
  assert.ok(
    !resolved.includes("AppData"),
    "Windows fallback must not use APPDATA: OpenCode V2 reads ~/.config/opencode",
  );
});

test("fallbackConfigDir uses ~/.config/opencode on every platform", () => {
  assert.strictEqual(
    fallbackConfigDir({ platform: "darwin", home: "/Users/dev" }),
    "/Users/dev/.config/opencode",
  );
  assert.strictEqual(
    fallbackConfigDir({ platform: "linux", home: "/home/dev" }),
    "/home/dev/.config/opencode",
  );
});

// ---------------------------------------------------------------------------
// Superpowers plugin registration (V2 uses `plugins`, not `plugin`)
// ---------------------------------------------------------------------------

test("mergePluginEntry writes the V2 `plugins` key and never the deprecated `plugin` key", () => {
  const config = ensureSchema({});
  mergePluginEntry(config);

  assert.deepStrictEqual(config.plugins, [SUPERPOWERS_SPEC]);
  assert.ok(!("plugin" in config), "V2 config must not contain the deprecated `plugin` key");
});

test("mergePluginEntry is idempotent", () => {
  const config = ensureSchema({});
  mergePluginEntry(config);
  mergePluginEntry(config);

  assert.deepStrictEqual(config.plugins, [SUPERPOWERS_SPEC]);
});

test("mergePluginEntry preserves plugins the user already registered", () => {
  const config = ensureSchema({ plugins: ["some-other-plugin"] });
  mergePluginEntry(config);

  assert.deepStrictEqual(config.plugins, ["some-other-plugin", SUPERPOWERS_SPEC]);
});

// ---------------------------------------------------------------------------
// MCP server registration (V2 nests servers under mcp.servers)
// ---------------------------------------------------------------------------

test("mergeMcpServer writes a schema-valid V2 local server entry", () => {
  const config = ensureSchema({});
  mergeMcpServer(config, { command: ["node", "C:\\repo\\index.js"] });

  assert.deepStrictEqual(config.mcp.servers["dev-workflow"], {
    type: "local",
    command: ["node", "C:\\repo\\index.js"],
  });
});

test("mergeMcpServer does not emit the V1 `enabled` flag", () => {
  const config = ensureSchema({});
  mergeMcpServer(config, { command: ["node", "index.js"] });

  assert.ok(
    !("enabled" in config.mcp.servers["dev-workflow"]),
    "`enabled` is not part of Mcp.LocalConfigEncoded in OpenCode V2",
  );
});

test("mergeMcpServer is idempotent and preserves other servers", () => {
  const config = ensureSchema({});
  mergeMcpServer(config, { command: ["node", "index.js"] });
  mergeMcpServer(config, { command: ["node", "index.js"] });
  mergeMcpServer(config, { name: "other", command: ["other-server"] });

  assert.deepStrictEqual(Object.keys(config.mcp.servers), ["dev-workflow", "other"]);
  assert.deepStrictEqual(config.mcp.servers["dev-workflow"].command, ["node", "index.js"]);
});

test("ensureSchema does not clobber existing providers", () => {
  const existing = { providers: { kenari: { models: { a: {} } } }, model: "kenari/a" };
  const config = ensureSchema(existing);

  assert.deepStrictEqual(config.providers, existing.providers);
  assert.strictEqual(config.model, "kenari/a");
  assert.strictEqual(config.$schema, "https://opencode.ai/config.json");
});

// ---------------------------------------------------------------------------
// Backup before mutating user config
// ---------------------------------------------------------------------------

test("backupPathFor places a timestamped backup inside the config directory", () => {
  const result = backupPathFor("C:\\Users\\<username>\\.config\\opencode", "opencode.json", "20261025-115000");

  assert.strictEqual(
    result,
    "C:\\Users\\<username>\\.config\\opencode\\secrets\\opencode-backup-20261025-115000.json",
  );
});

// ---------------------------------------------------------------------------
// Smoke test interpretation
// ---------------------------------------------------------------------------

test("smokeTestVerdict treats a running stdio server as a pass even if it exits 0", () => {
  // A stdio MCP server exits cleanly when its stdin closes. The setup script
  // previously used `stdin: 'ignore'`, which closed stdin immediately and made
  // a perfectly healthy server look like a failure.
  const verdict = smokeTestVerdict({
    exitedEarly: true,
    exitCode: 0,
    stdout: "[2026-10-25T05:27:54.822Z] Dev Workflow MCP Server running on stdio (startup took 7ms)",
    stderr: "",
  });

  assert.strictEqual(verdict.ok, true);
});

test("smokeTestVerdict still fails when the server crashes before starting", () => {
  const verdict = smokeTestVerdict({
    exitedEarly: true,
    exitCode: 1,
    stdout: "",
    stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dotenv'",
  });

  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /dotenv|exit/i);
});

test("smokeTestVerdict passes when the process stays alive past the timeout", () => {
  const verdict = smokeTestVerdict({ exitedEarly: false, exitCode: null, stdout: "", stderr: "" });

  assert.strictEqual(verdict.ok, true);
});
