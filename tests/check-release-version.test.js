import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkReleaseVersion, normalizeVersion } from "../scripts/check-release-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-release-version.mjs");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "github-release.yml");

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function withPackageJson(version, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "relver-"));
  try {
    const file = path.join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "uji", version }, null, 2));
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizeVersion membuang awalan v", () => {
  assert.equal(normalizeVersion("v1.15.1"), "1.15.1");
  assert.equal(normalizeVersion("1.15.1"), "1.15.1");
  assert.equal(normalizeVersion(" V2.0.0 "), "2.0.0");
  assert.equal(normalizeVersion(undefined), "");
});

test("tag dan package.json sama -> lolos", () => {
  const result = checkReleaseVersion({ tag: "v1.17.1", packageVersion: "1.17.1" });
  assert.equal(result.ok, true);
});

test("tag v1.15.1 dengan package.json 1.15.0 -> ditolak, sebut kedua versi", () => {
  // Kasus nyata 31 Oktober 2026: tag dibuat dari feat/dod-lock-guard, main
  // masih 1.15.0, dan npm menolak karena versi itu sudah terbit.
  const result = checkReleaseVersion({ tag: "v1.15.1", packageVersion: "1.15.0" });
  assert.equal(result.ok, false);
  assert.match(result.message, /v1\.15\.1/);
  assert.match(result.message, /1\.15\.0/);
  assert.match(result.message, /buat ulang tag/);
});

test("tag tanpa awalan v tetap dibandingkan sebagai versi", () => {
  const result = checkReleaseVersion({ tag: "1.15.0", packageVersion: "1.15.0" });
  assert.equal(result.ok, true);
});

test("tag kosong ditolak dengan pesan yang menjelaskan sumber tag", () => {
  const result = checkReleaseVersion({ tag: "", packageVersion: "1.15.0" });
  assert.equal(result.ok, false);
  assert.match(result.message, /GITHUB_REF_NAME/);
});

test("package.json tanpa version ditolak", () => {
  const result = checkReleaseVersion({ tag: "v1.15.0", packageVersion: undefined });
  assert.equal(result.ok, false);
  assert.match(result.message, /field version/);
});

test("CLI: ketidakcocokan keluar dengan kode 1", () => {
  withPackageJson("1.15.0", (file) => {
    const result = runCli(["--tag", "v1.15.1", "--package", file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1\.15\.1/);
    assert.match(result.stderr, /1\.15\.0/);
  });
});

test("CLI: versi yang cocok keluar dengan kode 0", () => {
  withPackageJson("1.17.1", (file) => {
    const result = runCli(["--tag", "v1.17.1", "--package", file]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /cocok/);
  });
});

test("CLI: package.json yang tidak ada keluar dengan kode 1 tanpa stack trace", () => {
  const result = runCli(["--tag", "v1.0.0", "--package", path.join(tmpdir(), "tidak-ada-relver.json")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tidak bisa membaca/);
  assert.doesNotMatch(result.stderr, /at Object\./);
});

test("workflow rilis memanggil pemeriksaan sebelum npm ci dan npm publish", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const checkIndex = yaml.indexOf("check-release-version.mjs");
  const installIndex = yaml.indexOf("npm ci");
  const publishIndex = yaml.indexOf("npm publish");

  assert.notEqual(checkIndex, -1, "github-release.yml harus memanggil check-release-version.mjs");
  assert.notEqual(installIndex, -1, "workflow harus tetap memasang dependensi");
  assert.notEqual(publishIndex, -1, "workflow harus tetap menerbitkan paket");
  assert.ok(
    checkIndex < installIndex,
    "pemeriksaan versi harus berjalan sebelum npm ci, bukan setelah build"
  );
  assert.ok(
    checkIndex < publishIndex,
    "pemeriksaan versi harus berjalan sebelum npm publish"
  );
});
