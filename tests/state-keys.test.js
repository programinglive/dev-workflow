import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionKeyWithSource,
  sanitizeSessionKey,
  normalizeProjectPath,
} from "../db/session-key.js";
import { StateConflict, StateUnavailable } from "../db/errors.js";

test("metadata request menang atas env", () => {
  const r = resolveSessionKeyWithSource({ DEV_WORKFLOW_SESSION_ID: "env-key" }, "ses_abc");
  assert.deepEqual(r, { key: "ses_abc", source: "request-metadata" });
});

test("tanpa metadata dan env, kunci adalah proc- acak dan sumbernya jujur", () => {
  const a = resolveSessionKeyWithSource({}, null);
  const b = resolveSessionKeyWithSource({}, null);
  assert.match(a.key, /^proc-[0-9a-f-]{36}$/);
  assert.equal(a.source, "process-random");
  assert.equal(a.key, b.key, "satu proses memakai satu kunci");
});

test("env dipakai bila metadata tidak ada", () => {
  const r = resolveSessionKeyWithSource({ OPENCODE_SESSION_ID: "ses_env" }, null);
  assert.deepEqual(r, { key: "ses_env", source: "env" });
});

test("sanitasi kunci sama dengan yang dipakai nama berkas legacy", () => {
  assert.equal(
    sanitizeSessionKey("ses_e6f3f146fffdUkCQUiSxpb75W6"),
    "ses_e6f3f146fffdUkCQUiSxpb75W6",
  );
  assert.equal(sanitizeSessionKey("a/b c"), "a-b-c");
});

test("project_path dinormalisasi sehingga satu proyek jadi satu baris", () => {
  const expected = process.platform === "win32" ? "d:/code/foo" : "D:/code/Foo";
  assert.equal(normalizeProjectPath("D:\\code\\Foo\\"), expected);
  assert.equal(normalizeProjectPath("d:/code/foo"), "d:/code/foo");
  assert.equal(normalizeProjectPath("D:\\code\\Foo"), expected);
});

test("normalisasi path mengosongkan nilai bukan-string", () => {
  assert.equal(normalizeProjectPath(null), "");
  assert.equal(normalizeProjectPath(undefined), "");
  assert.equal(normalizeProjectPath("   "), "");
});

test("error membawa kode dan detail", () => {
  const c = new StateConflict("bentrok", {
    sessionKey: "s",
    expectedVersion: 3,
    actualVersion: 4,
  });
  assert.equal(c.code, "STATE_CONFLICT");
  assert.equal(c.expectedVersion, 3);
  assert.equal(c.actualVersion, 4);
  assert.equal(c.sessionKey, "s");

  const u = new StateUnavailable("disk penuh", { cause: new Error("SQLITE_FULL") });
  assert.equal(u.code, "STATE_UNAVAILABLE");
  assert.equal(u.cause.message, "SQLITE_FULL");
});
