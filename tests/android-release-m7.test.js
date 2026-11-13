import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
  await t.test("M7: mobile-app/App.js maintains balanced Modal and ScrollView JSX tags for Metro bundler", () => {
    const appSource = fs.readFileSync(path.join(ROOT_DIR, "mobile-app", "App.js"), "utf8");
    const openModals = (appSource.match(/<Modal\b/g) || []).length;
    const closeModals = (appSource.match(/<\/Modal>/g) || []).length;
    assert.equal(openModals, closeModals, "Every <Modal> must have a matching </Modal>");

    const openScrolls = (appSource.match(/<ScrollView\b/g) || []).length;
    const closeScrolls = (appSource.match(/<\/ScrollView>/g) || []).length;
    assert.equal(openScrolls, closeScrolls, "Every <ScrollView> must have a matching </ScrollView>");
  });

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

  await t.test("M7: verifyReleaseApkArtifact computes SHA-256 and verifies APK zip magic header", async () => {
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwf-m7-apk-"));
    try {
      const validApk = path.join(tmpDir, "valid-fixture.apk");
      const validBuf = Buffer.alloc(1_050_000, 0x41);
      validBuf[0] = 0x50; // P
      validBuf[1] = 0x4b; // K
      validBuf[2] = 0x03;
      validBuf[3] = 0x04;
      fs.writeFileSync(validApk, validBuf);
      const tmpReport = verifyReleaseApkArtifact(validApk);
      assert.equal(tmpReport.exists, true);
      assert.equal(tmpReport.validZipHeader, true);
      assert.ok(tmpReport.sizeBytes > 1_000_000);
      assert.match(tmpReport.sha256, /^[a-f0-9]{64}$/);

      const badApk = path.join(tmpDir, "bad-header.apk");
      fs.writeFileSync(badApk, Buffer.alloc(16, 0x00));
      const badReport = verifyReleaseApkArtifact(badApk);
      assert.equal(badReport.exists, true);
      assert.equal(badReport.validZipHeader, false);

      const builtApkPath = path.join(
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
      if (fs.existsSync(builtApkPath)) {
        const builtReport = verifyReleaseApkArtifact(builtApkPath);
        assert.equal(builtReport.exists, true);
        assert.equal(builtReport.validZipHeader, true);
        assert.ok(builtReport.sizeBytes > 1_000_000);
        assert.match(builtReport.sha256, /^[a-f0-9]{64}$/);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  await t.test("Commiter v2 (^1.5.1) and DW Android Companion icon & splash assets are configured", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies["@programinglive/commiter"], "^1.5.1");
    assert.equal(pkg.scripts.release, "commiter release");
    assert.equal(pkg.commiter?.release?.branch, "main");

    const requiredAssets = [
      path.join(ROOT_DIR, "mobile-app", "assets", "icon.png"),
      path.join(ROOT_DIR, "mobile-app", "assets", "splash-icon.png"),
      path.join(ROOT_DIR, "mobile-app", "assets", "android-icon-foreground.png"),
    ];
    for (const assetPath of requiredAssets) {
      assert.equal(fs.existsSync(assetPath), true, `Missing asset: ${assetPath}`);
      assert.ok(fs.statSync(assetPath).size > 1000, `Asset unexpectedly small: ${assetPath}`);
    }

    const appJson = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "mobile-app", "app.json"), "utf8")
    );
    assert.equal(appJson.expo?.splash?.backgroundColor, "#080b12");
    assert.equal(appJson.expo?.android?.adaptiveIcon?.backgroundColor, "#080b12");

    // Prebuild-generated native Android resources are gitignored; verify when present locally.
    const androidResDir = path.join(ROOT_DIR, "mobile-app", "android", "app", "src", "main", "res");
    if (fs.existsSync(androidResDir)) {
      const prebuildAssets = [
        path.join(androidResDir, "mipmap-xxxhdpi", "ic_launcher.webp"),
        path.join(androidResDir, "drawable-xxxhdpi", "splashscreen_logo.png"),
      ];
      for (const assetPath of prebuildAssets) {
        assert.equal(fs.existsSync(assetPath), true, `Missing prebuild asset: ${assetPath}`);
        assert.ok(fs.statSync(assetPath).size > 1000, `Asset unexpectedly small: ${assetPath}`);
      }
      const colorsXml = fs.readFileSync(path.join(androidResDir, "values", "colors.xml"), "utf8");
      assert.match(colorsXml, /#080b12/);
    }
  });
});
