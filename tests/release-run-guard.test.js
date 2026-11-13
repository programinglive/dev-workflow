import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { runRelease } = require("../scripts/release.cjs");

// Kenapa tes ini ada:
//
// Guard versi harus aktif di dalam `runRelease`, bukan hanya sebagai fungsi
// lepas. Kalau standard-version "berhasil" (exit 0) tetapi meninggalkan
// package.json tanpa semver sah, seluruh rilis harus dianggap gagal supaya
// `perform_release` tidak mem-push tag-nya.

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "run-release-guard-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.13.2" }, null, 2),
  );
  return dir;
}

function fakeSpawn({ versionAfter }) {
  const calls = [];
  // runRelease memakai spawn sinkron (spawnSync), jadi tiruannya juga sinkron.
  const spawn = (executable, args) => {
    calls.push({ executable, args });

    // standard-version dipanggil sebagai `node <bin>/standard-version ...`
    const isStandardVersion = String(args?.[0] || "").includes("standard-version");
    if (isStandardVersion) {
      fs.writeFileSync(
        path.join(spawn.cwd, "package.json"),
        JSON.stringify({ name: "x", version: versionAfter }, null, 2),
      );
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  spawn.calls = calls;
  return spawn;
}

async function runWith(versionAfter) {
  const cwd = await makeRepo();
  const spawn = fakeSpawn({ versionAfter });
  spawn.cwd = cwd;
  try {
    const result = runRelease({
      argv: ["node", "scripts/release.cjs", "--release-as", "patch"],
      env: {},
      spawn,
      cwd,
      dependencies: {
        isWorkingTreeClean: () => true,
        fsExistsSync: () => true,
        updateReleaseNotes: () => false,
      },
    });
    return { result, spawn };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("runRelease gagal bila rilis meninggalkan version null", async () => {
  const { result, spawn } = await runWith(null);

  assert.equal(result.status, 1, "status harus non-zero supaya perform_release tidak push");
  assert.ok(result.error, "harus membawa error untuk dilaporkan");
  assert.match(result.error.message, /semver/i);

  const ranStandardVersion = spawn.calls.some((call) =>
    String(call.args?.[0] || "").includes("standard-version"),
  );
  assert.equal(ranStandardVersion, true, "standard-version tetap dijalankan lebih dulu");
});

test("runRelease gagal bila rilis meninggalkan version bukan semver", async () => {
  const { result } = await runWith("latest");
  assert.equal(result.status, 1);
  assert.match(result.error.message, /semver/i);
});

test("runRelease berhasil bila versi hasil rilis sah", async () => {
  const { result } = await runWith("1.13.3");
  assert.notEqual(result.status, 1, `tidak boleh gagal: ${result.error?.message || ""}`);
});

test("runRelease tidak memeriksa versi bila standard-version sendiri gagal", async () => {
  const cwd = await makeRepo();
  try {
    const spawn = (executable, args) => {
      const isStandardVersion = String(args?.[0] || "").includes("standard-version");
      return { status: isStandardVersion ? 2 : 0, stdout: "", stderr: "boom" };
    };
    const result = runRelease({
      argv: ["node", "scripts/release.cjs", "--release-as", "patch"],
      env: {},
      spawn,
      cwd,
      dependencies: {
        isWorkingTreeClean: () => true,
        fsExistsSync: () => true,
        updateReleaseNotes: () => false,
      },
    });

    assert.equal(result.status, 2, "kegagalan standard-version diteruskan apa adanya");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
