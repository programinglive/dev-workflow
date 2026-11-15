import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_DOC_BYTES,
  assertPreflightScope,
  discoverCli,
  findNestedAgents,
  readBounded,
  revalidatePreflight,
  runPreflight,
  summarizeInstructions,
} from "../preflight.js";
import { handleAcknowledgeInstructions } from "../tools/handler-modules/preflight-handlers.js";

async function withProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "devwf-preflight-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("README present is recorded with a fingerprint", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Project\n\nRead me first.\n");
    const record = runPreflight({ projectDir: root, taskId: "task-1" });
    assert.equal(record.ok, true);
    assert.equal(record.readmeMissing, false);
    assert.match(record.readme.path, /README\.md$/);
    assert.match(record.readme.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(record.taskId, "task-1");
  });
});

test("README missing is reported, not invented", async () => {
  await withProject(async (root) => {
    const record = runPreflight({ projectDir: root });
    assert.equal(record.ok, true);
    assert.equal(record.readmeMissing, true);
    assert.equal(record.readme, null);
  });
});

test("root AGENTS.md is discovered", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "AGENTS.md"), "# Rules\n\nDo the thing.\n");
    const record = runPreflight({ projectDir: root });
    assert.equal(record.agents.length, 1);
    assert.match(record.agents[0].path, /AGENTS\.md$/);
    assert.match(record.agents[0].fingerprint, /^[a-f0-9]{64}$/);
  });
});

test("nested AGENTS.md files are discovered within the bounded depth", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, "packages", "api"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Root\n");
    await writeFile(path.join(root, "packages", "AGENTS.md"), "# Packages\n");
    await writeFile(path.join(root, "packages", "api", "AGENTS.md"), "# API\n");
    const found = findNestedAgents(root);
    assert.equal(found.length, 3);
    const record = runPreflight({ projectDir: root });
    assert.equal(record.agents.length, 3);
  });
});

test("invalid projectDir is rejected", () => {
  const record = runPreflight({ projectDir: path.join(tmpdir(), "does-not-exist-devwf") });
  assert.equal(record.ok, false);
  assert.equal(record.code, "INVALID_PROJECT_ROOT");
});

test("a path outside the project is not read", async () => {
  await withProject(async (root) => {
    const outside = path.join(tmpdir(), "devwf-outside-readme.md");
    await writeFile(outside, "# Outside\n");
    const record = runPreflight({ projectDir: root });
    assert.equal(record.readmeMissing, true);
    assert.equal(record.readme, null);
  });
});

test("large README is truncated at the byte limit", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "x".repeat(MAX_DOC_BYTES + 1024));
    const doc = readBounded(path.join(root, "README.md"));
    assert.equal(doc.truncated, true);
    assert.ok(Buffer.byteLength(doc.text, "utf8") <= MAX_DOC_BYTES);
    const record = runPreflight({ projectDir: root });
    assert.equal(record.readme.truncated, true);
  });
});

test("CLI discovery covers package.json, composer.json, pyproject.toml and Makefile", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "vite build" } }));
    await writeFile(path.join(root, "composer.json"), JSON.stringify({ scripts: { "test:unit": "phpunit" } }));
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = 'x'\n");
    await writeFile(path.join(root, "Makefile"), "test:\n\techo ok\n");
    const refs = discoverCli(root);
    const sources = new Set(refs.map((r) => r.source));
    assert.ok(sources.has("package.json"));
    assert.ok(sources.has("composer.json"));
    assert.ok(sources.has("pyproject.toml"));
    assert.ok(sources.has("Makefile"));
    assert.ok(refs.every((r) => r.verified === false), "discovered commands must stay unverified");
  });
});

test("README change is detected on revalidation", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# One\n");
    const first = runPreflight({ projectDir: root });
    await writeFile(path.join(root, "README.md"), "# Two\n");
    const result = revalidatePreflight(first, { projectDir: root });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.ok(result.changes.includes("README_CHANGED"));
  });
});

test("unchanged guidance revalidates cleanly", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# One\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Rules\n");
    const first = runPreflight({ projectDir: root });
    const result = revalidatePreflight(first, { projectDir: root });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
  });
});

test("scope mismatch is rejected", async () => {
  await withProject(async (root) => {
    const record = runPreflight({ projectDir: root });
    const other = path.join(tmpdir(), "devwf-other-root");
    const result = assertPreflightScope(record, { projectDir: other, operation: "commit_and_push" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SCOPE_MISMATCH");
  });
});

test("matching scope is allowed", async () => {
  await withProject(async (root) => {
    const record = runPreflight({ projectDir: root });
    const result = assertPreflightScope(record, { projectDir: root, operation: "commit_and_push" });
    assert.equal(result.ok, true);
  });
});

test("a legacy task without a preflight record is allowed under the identity contract", () => {
  const result = assertPreflightScope(null, { projectDir: tmpdir(), operation: "commit_and_push" });
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
});

test("an invalid preflight record is a stale preflight, not permission", () => {
  const result = assertPreflightScope(
    { ok: false, code: "INVALID_PROJECT_ROOT" },
    { projectDir: tmpdir(), operation: "commit_and_push" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "STALE_PREFLIGHT");
});

test("the preflight record contains no document bodies or command output", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Secret-free\n\nTOKEN=should-not-be-copied\n");
    const record = runPreflight({ projectDir: root });
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes("should-not-be-copied"), false);
    assert.equal(serialized.includes("TOKEN="), false);
  });
});

test("instruction summary is actionable and bounded", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Project\n\nA small service.\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Rules\n\n- MUST run tests before commit\n- NEVER edit production directly\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "vite build", release: "npm run release" } }));
    const summary = summarizeInstructions({ projectDir: root, taskDescription: "Add a health endpoint" });
    assert.match(summary.purpose, /small service/i);
    assert.ok(summary.rules.some((rule) => /MUST run tests/i.test(rule)));
    assert.ok(summary.prohibited.some((rule) => /NEVER edit production/i.test(rule)));
    assert.ok(summary.buildTestRelease.some((ref) => ref.invocation === "npm run test"));
    assert.match(summary.taskScope, /health endpoint/i);
    assert.ok(summary.documentation.some((file) => /README\.md$/.test(file)));
    assert.ok(summary.text.length <= 2400);
  });
});

test("acknowledgment accepts a matching fingerprint and scope", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Project\n");
    const record = runPreflight({ projectDir: root });
    const state = { state: { preflight: record, instructionAcknowledgment: null }, save: async () => {} };
    const response = await handleAcknowledgeInstructions(
      { fingerprint: record.readme.fingerprint, scope: record.projectRoot },
      state
    );
    assert.match(response.content[0].text, /acknowledged/i);
    assert.equal(state.state.instructionAcknowledgment.fingerprint, record.readme.fingerprint);
  });
});

test("acknowledgment rejects a mismatched fingerprint", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Project\n");
    const record = runPreflight({ projectDir: root });
    const state = { state: { preflight: record, instructionAcknowledgment: null }, save: async () => {} };
    const response = await handleAcknowledgeInstructions(
      { fingerprint: "0".repeat(64), scope: record.projectRoot },
      state
    );
    assert.match(response.content[0].text, /rejected/i);
    assert.equal(state.state.instructionAcknowledgment, null);
  });
});

test("acknowledgment rejects a mismatched scope", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "README.md"), "# Project\n");
    const record = runPreflight({ projectDir: root });
    const state = { state: { preflight: record, instructionAcknowledgment: null }, save: async () => {} };
    const response = await handleAcknowledgeInstructions(
      { fingerprint: record.readme.fingerprint, scope: "/somewhere/else" },
      state
    );
    assert.match(response.content[0].text, /rejected/i);
  });
});

test("acknowledgment requires a preflight record", async () => {
  const state = { state: { preflight: null, instructionAcknowledgment: null }, save: async () => {} };
  const response = await handleAcknowledgeInstructions({ fingerprint: "x", scope: "y" }, state);
  assert.match(response.content[0].text, /No preflight record/i);
});
