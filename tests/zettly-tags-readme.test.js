import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the README documents the four tag axes", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /Zettly tags for zettelkasten relations/i);
  for (const axis of ["proyek:", "tipe:", "area:", "sumber:"]) {
    assert.ok(readme.includes(axis), `README should document ${axis}`);
  }
});

test("the README records the tag API shapes that caused real bugs", () => {
  const readme = readFileSync("README.md", "utf8");
  // Top-level { tags } with no data wrapper, and a 409 meaning "already exists".
  assert.match(readme, /deletedTags/);
  assert.match(readme, /409/);
});

test("the README documents the backfill command and its dry run", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /zettly:backfill-tags/);
  assert.match(readme, /--dry-run/);
});
