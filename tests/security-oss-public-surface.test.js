import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function walkFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (stat.isFile()) {
      results.push(full);
    }
  }
  return results;
}

test("OSS public docs exclude private audit artifacts, backup bundles, and private workstation/tailnet details", () => {
  const forbiddenFiles = [
    join(ROOT, "docs", "opensource", "migration-audit-record.md"),
    join(ROOT, "docs", "opensource", "frozen-source-manifest.json"),
  ];
  for (const file of forbiddenFiles) {
    assert.equal(existsSync(file), false, `Forbidden private/stale file exists: ${relative(ROOT, file)}`);
  }

  const publicDocFiles = [
    ...walkFiles(join(ROOT, "docs")),
    join(ROOT, "README.md"),
    join(ROOT, "CHANGELOG.md"),
  ].filter((file) => existsSync(file));

  const globalForbiddenPatterns = [
    { name: "Tailscale 100.x private IP", regex: /\b100\.(?:77|107)\.\d+\.\d+\b/ },
    { name: "Legacy public database IP", regex: /\b34\.50\.121\.142\b/ },
    { name: "Local backup bundle path", regex: /dev-workflow-private-backup-[^\s`"')>]+\.bundle|\.bundle\b/ },
    { name: "Owner local workstation path", regex: /C:[\\/]Users[\\/]DHIKA/i },
  ];

  const opensourceDocForbiddenPatterns = [
    { name: "Legacy secret commit hash (69e7f38)", regex: /\b69e7f38\b/ },
    { name: "Legacy secret commit hash (3adb4cb)", regex: /\b3adb4cb\b/ },
    { name: "Migration audit filename reference", regex: /migration-audit-record\.md/ },
  ];

  const violations = [];
  for (const file of publicDocFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const content = readFileSync(file, "utf8");

    for (const { name, regex } of globalForbiddenPatterns) {
      if (regex.test(content)) {
        violations.push(`${rel}: matched ${name}`);
      }
    }

    if (rel.startsWith("docs/opensource/")) {
      for (const { name, regex } of opensourceDocForbiddenPatterns) {
        if (regex.test(content)) {
          violations.push(`${rel}: matched ${name}`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `Public documentation privacy violations:\n${violations.join("\n")}`);
});
