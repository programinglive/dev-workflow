import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function packedPaths() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `npm pack --dry-run failed: ${result.stderr}\n${result.error || ""}`);
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] || parsed;
  return (entry.files || []).map((file) => String(file.path).replace(/\\/g, "/"));
}

test("npm pack excludes runtime state and generated identity files", () => {
  const npmIgnore = fs.readFileSync(path.join(ROOT, ".npmignore"), "utf8");
  const gitIgnore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  for (const ignoreFile of [npmIgnore, gitIgnore]) {
    const lines = ignoreFile.split(/\r?\n/).map((line) => line.trim());
    assert.ok(lines.includes("state/"), "ignore file must exclude the runtime state/ directory");
    assert.ok(
      lines.includes("user-id") || lines.includes("**/user-id"),
      "ignore file must exclude generated user-id files",
    );
  }

  const paths = packedPaths();
  const leaked = paths.filter(
    (file) =>
      file.startsWith("state/") ||
      path.posix.basename(file) === "user-id" ||
      file.endsWith(".db") ||
      file.endsWith(".db-wal") ||
      file.endsWith(".db-shm"),
  );
  assert.deepEqual(leaked, [], "npm tarball must not contain runtime state or identity files");
});

test("npm pack keeps the files required to run the MCP server", () => {
  const paths = new Set(packedPaths());
  const required = [
    "package.json",
    "README.md",
    "index.js",
    "cli/args.js",
    "managed/fleet-providers.cjs",
    "tools/definitions.js",
    "src/tool-profiles.js",
    "src/tool-profile-cost.js",
    "src/vendor/zettly-code/LICENSE",
    "src/vendor/zettly-code/src/index.js",
    "engineering/zettly-code-sidecars/gitignore-generated-artifacts.json",
  ];
  for (const file of required) {
    assert.ok(paths.has(file), `published package is missing required file ${file}`);
  }
});
