import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildStandardVersionArgs, getCliArguments } = require("../scripts/release.cjs");

// Kenapa tes ini ada:
//
// 30 Oktober 2026 `perform_release` menulis `"version": null` ke package.json
// dan membuat tag `vnull`. Rantainya:
//
//   perform_release -> `npm run release -- --release-as patch`
//   release.cjs     -> releaseType = "patch", extraArgs = ["--release-as","patch"]
//   buildStandardVersionArgs -> "--release-as patch" dua kali
//   yargs           -> releaseAs = ["patch","patch"]
//   semver.inc("1.13.2", ["patch","patch"]) -> null
//
// Argumen tidak boleh memuat `--release-as` lebih dari sekali.

function countReleaseAs(args) {
  return args.filter((arg) => arg === "--release-as").length;
}

test("tidak menggandakan --release-as saat CLI sudah menyebutnya", () => {
  const parsed = getCliArguments(["node", "scripts/release.cjs", "--release-as", "patch"]);
  const args = buildStandardVersionArgs(parsed);

  assert.equal(countReleaseAs(args), 1, `--release-as harus muncul sekali, dapat: ${JSON.stringify(args)}`);
  assert.deepEqual(args, ["--release-as", "patch"]);
});

test("menghasilkan tepat satu --release-as untuk setiap bentuk pemanggilan", () => {
  const cases = [
    [["node", "scripts/release.cjs", "--release-as", "patch"], "patch"],
    [["node", "scripts/release.cjs", "--release-as", "minor"], "minor"],
    [["node", "scripts/release.cjs", "--release-as", "major"], "major"],
    [["node", "scripts/release.cjs", "--release-as", "1.14.0"], "1.14.0"],
    [["node", "scripts/release.cjs", "patch"], "patch"],
    [["node", "scripts/release.cjs"], "patch"],
  ];

  for (const [argv, expected] of cases) {
    const args = buildStandardVersionArgs(getCliArguments(argv));
    assert.equal(countReleaseAs(args), 1, `gagal untuk ${JSON.stringify(argv)}: ${JSON.stringify(args)}`);
    const index = args.indexOf("--release-as");
    assert.equal(args[index + 1], expected, `tipe rilis salah untuk ${JSON.stringify(argv)}`);
  }
});

test("--first-release tidak ikut digandakan atau diteruskan", () => {
  const args = buildStandardVersionArgs(
    getCliArguments(["node", "scripts/release.cjs", "--first-release"]),
  );

  assert.deepEqual(args, ["--release-as", "0.0.1"]);
  assert.equal(args.includes("--first-release"), false);
});

test("argumen lain tetap diteruskan", () => {
  const args = buildStandardVersionArgs(
    getCliArguments(["node", "scripts/release.cjs", "--release-as", "patch", "--dry-run"]),
  );

  assert.equal(countReleaseAs(args), 1);
  assert.equal(args.includes("--dry-run"), true);
});

test("tipe rilis yang tidak dikenal tetap ditolak", () => {
  assert.throws(
    () => buildStandardVersionArgs(getCliArguments(["node", "scripts/release.cjs", "--release-as", "nonsense"])),
    /Unknown release type|tidak dikenal/i,
  );
});

test("release-as tanpa nilai ditolak, bukan diteruskan", () => {
  // `--release-as` tanpa nilai membuat yargs memberinya `true`, dan
  // semver.inc(version, true) juga menghasilkan null.
  assert.throws(
    () => buildStandardVersionArgs(getCliArguments(["node", "scripts/release.cjs", "--release-as"])),
    /Unknown release type|tidak dikenal|nilai/i,
  );
});
