import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, buildReport } from "../scripts/check-update.mjs";

test("compareVersions mengurutkan versi numerik", () => {
  assert.equal(compareVersions("1.15.1", "1.15.0"), 1);
  assert.equal(compareVersions("1.15.0", "1.15.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
});

test("compareVersions memperlakukan prerelease lebih rendah dari rilis", () => {
  assert.equal(compareVersions("1.16.0-beta.1", "1.16.0"), -1);
  assert.equal(compareVersions("1.16.0", "1.16.0-beta.1"), 1);
});

test("buildReport: dua-duanya mutakhir -> exit 0", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "1.15.1",
    localSha: "38be409",
    remoteSha: "38be409",
    errors: [],
  });
  assert.equal(r.exitCode, 0);
});

test("buildReport: clone tertinggal -> exit 1 dan sebut git pull", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "1.15.0",
    localSha: "38be409",
    remoteSha: "a1b2c3d",
    errors: [],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.human, /git pull/);
  assert.match(r.human, /restart proses MCP/);
});

test("buildReport: clone lebih maju dari npm dilaporkan apa adanya", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "1.15.0",
    localSha: "38be409",
    remoteSha: "38be409",
    errors: [],
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.human, /lebih baru dari rilis publik/);
});

test("buildReport: npm lebih baru -> exit 1 dan sebut npm install", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "1.16.0",
    localSha: "38be409",
    remoteSha: "38be409",
    errors: [],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.human, /npm install/);
});

test("buildReport: semua sumber gagal -> exit 2, tidak melempar", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "",
    localSha: "",
    remoteSha: "",
    errors: ["npm: timeout", "git: tidak ada remote"],
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.human, /tidak bisa diperiksa/);
});

test("buildReport: --json menghasilkan objek yang sama", () => {
  const r = buildReport({
    localVersion: "1.15.1",
    npmVersion: "1.15.1",
    localSha: "a",
    remoteSha: "a",
    errors: [],
  });
  assert.equal(r.json.localVersion, "1.15.1");
  assert.equal(r.json.exitCode, 0);
});
