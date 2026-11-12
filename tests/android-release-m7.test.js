import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  verifyAndroidReleaseWorkflow,
  verifyReleaseApkArtifact,
  parseAdbDevicesOutput,
} = require("../mobile-app/verify-apk-release.cjs");

const ROOT_DIR = path.resolve(import.meta.dirname, "..");

test("Milestone M7: Android APK Release Workflow & Verification", async (t) => {
  await t.test("M7: .github/workflows/android-release.yml enforces locked deps, tests, signing, apksigner, and sha256", () => {
    const result = verifyAndroidReleaseWorkflow(
      path.join(ROOT_DIR, ".github", "workflows", "android-release.yml")
    );
    assert.equal(result.ok, true);
    assert.equal(result.checks.lockedDependencies, true);
    assert.equal(result.checks.automatedTests, true);
    assert.equal(result.checks.gradleAssembleRelease, true);
    assert.equal(result.checks.ciSecretSigning, true);
    assert.equal(result.checks.apksignerVerify, true);
    assert.equal(result.checks.sha256Artifact, true);
    assert.equal(result.checks.noCommittedKeystoreSecret, true);
  });

  await t.test("M7: verifyReleaseApkArtifact computes SHA-256 and verifies APK zip magic header", () => {
    const apkPath = path.join(
      ROOT_DIR,
      "mobile-app",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release.apk"
    );
    const report = verifyReleaseApkArtifact(apkPath);
    assert.equal(report.exists, true);
    assert.equal(report.validZipHeader, true);
    assert.ok(report.sizeBytes > 1_000_000);
    assert.match(report.sha256, /^[a-f0-9]{64}$/);
  });

  await t.test("M7: parseAdbDevicesOutput identifies Xiaomi Pad 6 (pipa / 23043RP34G) accurately", () => {
    const sampleConnected = [
      "List of devices attached",
      "adb-a0de743b-IMnNgC (2)._adb-tls-connect._tcp device product:pipa_id model:23043RP34G device:pipa transport_id:1",
      "",
    ].join("\n");
    const parsed = parseAdbDevicesOutput(sampleConnected);
    assert.equal(parsed.deviceCount, 1);
    assert.equal(parsed.xiaomiPad6Detected, true);
    assert.equal(parsed.devices[0].model, "23043RP34G");
    assert.equal(parsed.devices[0].device, "pipa");

    const sampleEmpty = "List of devices attached\n\n";
    const parsedEmpty = parseAdbDevicesOutput(sampleEmpty);
    assert.equal(parsedEmpty.deviceCount, 0);
    assert.equal(parsedEmpty.xiaomiPad6Detected, false);
  });
});
