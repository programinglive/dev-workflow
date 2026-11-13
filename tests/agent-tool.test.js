import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectTool, DEFAULT_TOOL } = require("../agent-tool.cjs");

/**
 * Pemilik memakai tiga alat terhadap server MCP yang sama - Codex,
 * Antigravity, OpenCode - dan ingin dashboard menyebut mana yang dipakai.
 *
 * Yang dijaga: label TIDAK BOLEH menebak. Bila tidak ada petunjuk, hasilnya
 * "unknown", bukan alat pertama yang kebetulan cocok.
 */

test("DEVWF_AGENT eksplisit menang atas segalanya", () => {
  assert.equal(
    detectTool({
      env: { DEVWF_AGENT: "Codex" },
      metaKeys: ["ai.opencode/sessionID"],
      commandLine: "antigravity",
    }),
    "codex",
    "nilai eksplisit tidak boleh dikalahkan tebakan",
  );
});

test("metadata MCP mengenali Codex dan OpenCode", () => {
  assert.equal(detectTool({ metaKeys: ["codex/sessionID"] }), "codex");
  assert.equal(detectTool({ metaKeys: ["ai.opencode/sessionID"] }), "opencode");
  assert.equal(detectTool({ metaKeys: ["antigravity/session"] }), "antigravity");
});

test("metadata menang atas nama proses", () => {
  assert.equal(
    detectTool({ metaKeys: ["codex/sessionID"], commandLine: "antigravity-agent" }),
    "codex",
  );
});

test("nama proses dipakai bila metadata tidak ada", () => {
  assert.equal(detectTool({ commandLine: "C:\\Program Files\\Antigravity\\agent.exe" }), "antigravity");
  assert.equal(detectTool({ commandLine: "codex-cli run" }), "codex");
  assert.equal(detectTool({ commandLine: "/usr/local/bin/opencode" }), "opencode");
});

test("tanpa petunjuk apa pun: unknown, bukan tebakan", () => {
  assert.equal(detectTool({}), DEFAULT_TOOL);
  assert.equal(detectTool({ metaKeys: [] }), DEFAULT_TOOL);
  assert.equal(detectTool({ metaKeys: ["sesuatu/lain"] }), DEFAULT_TOOL);
  assert.equal(detectTool({ commandLine: "node index.js" }), DEFAULT_TOOL);
  assert.equal(DEFAULT_TOOL, "unknown");
});

test("nama tool selalu huruf kecil", () => {
  assert.equal(detectTool({ env: { DEVWF_AGENT: "OPENCODE" } }), "opencode");
  assert.equal(detectTool({ env: { DEVWF_AGENT: "  Antigravity  " } }), "antigravity");
});

test("input aneh tidak melempar", () => {
  assert.equal(detectTool(), DEFAULT_TOOL);
  assert.equal(detectTool({ metaKeys: null }), DEFAULT_TOOL);
  assert.equal(detectTool({ metaKeys: [null, 123, ""] }), DEFAULT_TOOL);
  assert.equal(detectTool({ env: null }), DEFAULT_TOOL);
});
