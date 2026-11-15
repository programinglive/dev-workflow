import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectViolations,
  findViolation,
  scanSource,
} from "../scripts/check-english.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-english.mjs");

/**
 * Regression tests for the English-only engineering policy.
 *
 * The examples below are the exact strings the owner reported in
 * tests/monitor-token-rotation.test.js. They must be detected, and their English
 * replacements must not be. Each fixture line carries a `language-allow`
 * directive because the Indonesian text is intentional test data, which is one
 * of the documented exceptions.
 */

const REPORTED = {
  comments: [
    "Token lama hanya berlaku bila diisi; kosong berarti tidak ada toleransi.", // language-allow: reported violation fixture
    "Perilaku dasar tidak boleh berubah karena penambahan token lama.", // language-allow: reported violation fixture
    "Rotasi token harus bisa dilakukan TANPA memutus mesin yang belum diperbarui.", // language-allow: reported violation fixture
  ],
  testDescriptions: [
    "server punya jalur token lama selama masa rotasi", // language-allow: reported violation fixture
    "ketiga endpoint tulis memakai pemeriksaan yang sama", // language-allow: reported violation fixture
    "templat env monitor mendokumentasikan token tanpa nilai nyata", // language-allow: reported violation fixture
    "aturan token tetap: kosong ditolak, salah ditolak", // language-allow: reported violation fixture
  ],
  assertionMessages: [
    "POST /api/session, /api/event dan /api/reaper/action harus dijaga", // language-allow: reported violation fixture
  ],
  identifiers: ["panggilan", "GANTI_TOKEN_PANJANG_ACAK"], // language-allow: reported violation fixture
};

test("every reported Indonesian comment is detected", () => {
  for (const text of REPORTED.comments) {
    assert.ok(findViolation(text), `comment must be flagged: ${text}`);
  }
});

test("every reported Indonesian test description is detected", () => {
  for (const text of REPORTED.testDescriptions) {
    assert.ok(findViolation(text), `test description must be flagged: ${text}`);
  }
});

test("the reported Indonesian assertion message is detected", () => {
  for (const text of REPORTED.assertionMessages) {
    assert.ok(findViolation(text), `assertion message must be flagged: ${text}`);
  }
});

test("the reported Indonesian identifiers are detected", () => {
  for (const text of REPORTED.identifiers) {
    assert.ok(findViolation(text, { identifier: true }), `identifier must be flagged: ${text}`);
  }
});

test("the English replacements are not flagged", () => {
  const english = [
    "The previous token is only valid while it is set; empty means no tolerance.",
    "The base behaviour must not change because a previous token was added.",
    "Token rotation must be possible without disconnecting a machine that has not been updated yet.",
    "the server keeps a previous-token path during rotation",
    "all three write endpoints use the same check",
    "the monitor env template documents the token without a real value",
    "token rules stay the same: empty is rejected, wrong is rejected",
    "POST /api/session, /api/event and /api/reaper/action must all be guarded",
    "previousToken",
    "REPLACE_WITH_LONG_RANDOM_TOKEN",
  ];
  for (const text of english) {
    assert.equal(findViolation(text), null, `English text must pass: ${text}`);
    assert.equal(findViolation(text, { identifier: true }), null, `English identifier must pass: ${text}`);
  }
});

test("a single short ambiguous marker is not enough to fail", () => {
  // "sama", "jam" and "isi" are also names and loanwords; one alone is noise. // language-allow: marker fixture
  assert.equal(findViolation("the sama project"), null);
  assert.equal(findViolation("jam session"), null);
  // Two different short markers together are evidence.
  assert.ok(findViolation("sama jam")); // language-allow: reported violation fixture
});

test("the scanner separates comments, strings and identifiers", () => {
  const source = [
    "// a comment",
    "const value = 'a string';",
    "function panggilan() {}", // language-allow: reported violation fixture
  ].join("\n");
  const { comments, strings, identifiers } = scanSource(source);
  assert.equal(comments.length, 1);
  assert.equal(strings.length, 1);
  assert.ok(identifiers.some((item) => item.text === "panggilan")); // language-allow: reported violation fixture
});

test("a regex literal is not scanned as an identifier", () => {
  const source = "assert.match(dash, /function tombolReaper\\(action\\)/);";
  const { identifiers } = scanSource(source);
  assert.equal(identifiers.some((item) => item.text === "tombolReaper"), false);
});

test("the language-allow directive exempts one line with a written reason", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await writeFile(
      path.join(dir, "allowed.js"),
      "export const label = 'Simpan perubahan'; // language-allow: localized product copy\n", // language-allow: localized product copy
      "utf8",
    );
    const violations = await collectViolations({ root: dir });
    assert.deepEqual(violations, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localization paths are exempt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await mkdir(path.join(dir, "locales"), { recursive: true });
    await writeFile(
      path.join(dir, "locales", "id.js"),
      "export const save = 'Simpan perubahan';\n", // language-allow: localized product copy
      "utf8",
    );
    const violations = await collectViolations({ root: dir });
    assert.deepEqual(violations, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an isolated fixture with an intentional violation fails the CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await writeFile(
      path.join(dir, "violation.test.js"),
      'test("server punya jalur token lama selama masa rotasi", () => {});\n', // language-allow: reported violation fixture
      "utf8",
    );
    const result = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--all"], { encoding: "utf8" });
    assert.equal(result.status, 1, "the gate must fail on a new violation");
    assert.match(result.stderr, /new Indonesian engineering text/);
    assert.match(result.stderr, /violation\.test\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an isolated clean fixture passes the CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await writeFile(
      path.join(dir, "clean.test.js"),
      'test("the server keeps a previous-token path during rotation", () => {});\n',
      "utf8",
    );
    const result = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--all"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the repository itself has no new violations", async () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8" });
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true, `new violations: ${JSON.stringify(report.fresh, null, 2)}`);
  assert.equal(report.fresh.length, 0);
});

test("the reported file is clean", async () => {
  const violations = await collectViolations({ root: ROOT });
  const reported = violations.filter((item) => item.file === "tests/monitor-token-rotation.test.js");
  assert.deepEqual(reported, [], "the reported file must contain no Indonesian engineering text");
});

test("the governed preflight skips a task without a pinned project directory", async () => {
  const { evaluateEnglishPolicy } = await import("../tools/handler-modules/status-handlers.js");
  assert.deepEqual(evaluateEnglishPolicy({ state: {} }), { ok: true, skipped: true, report: "" });
});

test("the governed preflight skips a project without the checker", async () => {
  const { evaluateEnglishPolicy } = await import("../tools/handler-modules/status-handlers.js");
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    const result = evaluateEnglishPolicy({ state: { projectDir: dir } });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the governed preflight blocks a project whose checker fails", async () => {
  const { evaluateEnglishPolicy } = await import("../tools/handler-modules/status-handlers.js");
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(
      path.join(dir, "scripts", "check-english.mjs"),
      "process.stderr.write('new Indonesian engineering text found\\n');\nprocess.exitCode = 1;\n",
      "utf8",
    );
    const result = evaluateEnglishPolicy({ state: { projectDir: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.report, /new Indonesian engineering text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the governed preflight passes a project whose checker passes", async () => {
  const { evaluateEnglishPolicy } = await import("../tools/handler-modules/status-handlers.js");
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-english-"));
  try {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(
      path.join(dir, "scripts", "check-english.mjs"),
      "process.stdout.write('English policy: OK\\n');\n",
      "utf8",
    );
    const result = evaluateEnglishPolicy({ state: { projectDir: dir } });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
