import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { verifyReleaseVersion, SEMVER_REGEX } = require("../scripts/release.cjs");

// Kenapa tes ini ada:
//
// 30 Oktober 2026 `perform_release` menulis `"version": null` dan membuat tag
// `vnull`, lalu mem-push keduanya. SEMVER_REGEX sudah ada, tetapi hanya dipakai
// memvalidasi tipe rilis MASUKAN - hasil rilis tidak pernah diperiksa.
//
// Guard ini memeriksa package.json SETELAH standard-version berjalan, supaya
// rilis yang rusak berhenti sebelum tag-nya keluar dari mesin.

async function makeRepo(version) {
  const dir = await mkdtemp(path.join(tmpdir(), "verify-release-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version }, null, 2));
  return dir;
}

test("menerima versi semver yang sah", async () => {
  for (const version of ["1.13.3", "0.0.1", "2.0.0", "1.0.0-beta.1", "1.0.0-rc.2"]) {
    const dir = await makeRepo(version);
    try {
      assert.equal(verifyReleaseVersion({ cwd: dir }), version);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("menolak version null - bentuk kerusakan yang sebenarnya terjadi", async () => {
  const dir = await makeRepo(null);
  try {
    assert.throws(() => verifyReleaseVersion({ cwd: dir }), /null|semver|versi/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("menolak version yang hilang", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verify-release-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    assert.throws(() => verifyReleaseVersion({ cwd: dir }), /semver|versi|version/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("menolak version yang bukan string", async () => {
  for (const version of [1.13, true, ["1.13.3"], { v: "1.13.3" }]) {
    const dir = await makeRepo(version);
    try {
      assert.throws(() => verifyReleaseVersion({ cwd: dir }), /semver|versi|version/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("menolak string yang bukan semver", async () => {
  for (const version of ["", " ", "1.13", "v1.13.3", "1.13.3.4", "latest", "null"]) {
    const dir = await makeRepo(version);
    try {
      assert.throws(
        () => verifyReleaseVersion({ cwd: dir }),
        /semver|versi|version/i,
        `seharusnya menolak ${JSON.stringify(version)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("menolak package.json yang tidak ada atau rusak", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verify-release-"));
  try {
    assert.throws(() => verifyReleaseVersion({ cwd: dir }), /package\.json|tidak/i);

    await writeFile(path.join(dir, "package.json"), "{ bukan json");
    assert.throws(() => verifyReleaseVersion({ cwd: dir }), /package\.json|JSON/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pesan error menyebut nilai yang bermasalah supaya bisa didiagnosis", async () => {
  const dir = await makeRepo(null);
  try {
    assert.throws(
      () => verifyReleaseVersion({ cwd: dir }),
      (error) => {
        assert.match(error.message, /null/, "harus menyebut nilai yang didapat");
        assert.match(error.message, /semver/i, "harus menyebut aturan yang dilanggar");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SEMVER_REGEX tidak menerima nilai kosong atau null", () => {
  assert.equal(SEMVER_REGEX.test("1.13.3"), true);
  assert.equal(SEMVER_REGEX.test(""), false);
  assert.equal(SEMVER_REGEX.test("null"), false);
});
