import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the README documents every devwf subcommand", () => {
  const readme = readFileSync("README.md", "utf8");
  for (const command of ["devwf list", "devwf close", "devwf share", "devwf drop", "devwf complete"]) {
    assert.ok(readme.includes(command), `README should mention "${command}"`);
  }
});

test("the README documents the CLI rules a script depends on", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /DEVWF_MONITOR_URL/);
  assert.match(readme, /DEVWF_MONITOR_TOKEN/);
  assert.match(readme, /--dry-run/);
  // No process is signalled, and a missing target is a refusal.
  assert.match(readme, /No process is ever signalled/i);
  assert.match(readme, /--session` is mandatory/i);
  assert.match(readme, /Exit code 0 means it really happened/i);
});

test("package.json exposes the devwf binary and keeps the MCP entry", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.bin.devwf, "bin/cli.js");
  assert.equal(pkg.bin["dev-workflow-mcp"], "index.js");
});
