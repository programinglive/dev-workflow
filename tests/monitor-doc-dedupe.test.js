/**
 * Guards the monitor runbook against duplicated sections.
 *
 * docs/monitor-dashboard.md once carried two verbatim copies of the
 * "Zettly Draw Mermaid Flow Preview" section (heading, bullets, and the
 * monitor-server file table). A second copy was added when the dashboard
 * docs were regenerated while the first one was still in the file.
 *
 * This test fails whenever any `##` heading in that document appears more
 * than once, which is what a duplicated section always looks like.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(repoRoot, "docs", "monitor-dashboard.md");

function headingCounts(markdown) {
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^##\s+(.*)$/);
    if (!match) continue;
    const title = match[1].trim();
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return counts;
}

test("the monitor dashboard doc has no duplicated section headings", () => {
  const markdown = readFileSync(docPath, "utf8");
  const counts = headingCounts(markdown);
  const duplicated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([title, count]) => `"${title}" x${count}`);
  assert.deepEqual(duplicated, [], `Duplicated section headings: ${duplicated.join(", ")}`);
});

test("the Zettly Draw preview section exists exactly once", () => {
  const markdown = readFileSync(docPath, "utf8");
  const occurrences = markdown.match(/^## Zettly Draw Mermaid Flow Preview$/gm) ?? [];
  assert.equal(occurrences.length, 1);
});
