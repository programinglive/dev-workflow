import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolVersion, REQUIRED_TOOLS } from "../toolchain.js";

/**
 * Owner request, 10 November 2026: the monitor must show whether every device
 * runs the same MCP version and has the same required command-line tools
 * (gh, glab, wrangler, gcloud, ...). "Same everywhere" is the property being
 * checked, so the version string has to be extracted the same way for every
 * tool's own output format.
 */

test("the required tool list names the tools the fleet depends on", () => {
  for (const tool of ["gh", "glab", "wrangler", "gcloud", "node", "npm"]) {
    assert.ok(REQUIRED_TOOLS.includes(tool), `${tool} must be required`);
  }
});

test("gh output yields its version", () => {
  assert.equal(parseToolVersion("gh", "gh version 2.40.1 (2024-01-01)"), "2.40.1");
});

test("glab output yields its version", () => {
  assert.equal(parseToolVersion("glab", "glab version 1.36.0 (2024-02-02)"), "1.36.0");
});

test("wrangler output yields its version", () => {
  assert.equal(parseToolVersion("wrangler", " ⛅️ wrangler 3.78.12"), "3.78.12");
});

test("gcloud output yields the SDK version, not the timestamp", () => {
  const out = "Google Cloud SDK 458.0.0\nbq 2.1.5\ncore 2024.01.01\n";
  assert.equal(parseToolVersion("gcloud", out), "458.0.0");
});

test("node's leading v is dropped so versions compare like with like", () => {
  assert.equal(parseToolVersion("node", "v20.11.0"), "20.11.0");
});

test("npm's plain version is read", () => {
  assert.equal(parseToolVersion("npm", "10.2.4\n"), "10.2.4");
});

test("empty output is reported as missing, never guessed", () => {
  assert.equal(parseToolVersion("gh", ""), null);
  assert.equal(parseToolVersion("gh", "   \n"), null);
});

test("output with no version at all is reported as missing", () => {
  assert.equal(parseToolVersion("gh", "command not found"), null);
});

test("a pre-release suffix is kept so two builds are not confused", () => {
  assert.equal(parseToolVersion("wrangler", "wrangler 4.0.0-beta.1"), "4.0.0-beta.1");
});
