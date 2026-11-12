#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

function verifyAndroidReleaseWorkflow(workflowPath) {
  if (!fs.existsSync(workflowPath)) {
    return { ok: false, error: "Workflow file not found", checks: {} };
  }
  const content = fs.readFileSync(workflowPath, "utf8");
  const checks = {
    lockedDependencies: /npm ci/.test(content),
    automatedTests: /npm test/.test(content),
    gradleAssembleRelease: /assembleRelease/.test(content),
    ciSecretSigning: /secrets\.ANDROID_KEYSTORE_BASE64/.test(content),
    apksignerVerify: /apksigner/.test(content) && /verify/.test(content),
    sha256Artifact: /sha256sum/.test(content) && /app-release\.apk\.sha256/.test(content),
    noCommittedKeystoreSecret: !/storePassword\s+['"][^'"]+['"]/.test(content),
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks };
}

function verifyReleaseApkArtifact(apkPath) {
  if (!fs.existsSync(apkPath)) {
    return {
      exists: false,
      apkPath,
      sizeBytes: 0,
      sha256: null,
      validZipHeader: false,
    };
  }
  const stat = fs.statSync(apkPath);
  const fd = fs.openSync(apkPath, "r");
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  const validZipHeader =
    magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;

  const hash = crypto.createHash("sha256");
  const fileBuffer = fs.readFileSync(apkPath);
  hash.update(fileBuffer);
  const sha256 = hash.digest("hex");

  const sha256FilePath = `${apkPath}.sha256`;
  fs.writeFileSync(sha256FilePath, `${sha256}  ${path.basename(apkPath)}\n`, "utf8");

  return {
    exists: true,
    apkPath,
    sizeBytes: stat.size,
    sha256,
    sha256FilePath,
    validZipHeader,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function parseAdbDevicesOutput(rawOutput) {
  const lines = String(rawOutput || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("List of devices") && !l.startsWith("* daemon"));

  const devices = lines
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      const state = parts.find((p) => p === "device" || p === "offline" || p === "unauthorized") || parts[1];
      const modelMatch = line.match(/model:([^\s]+)/);
      const deviceMatch = line.match(/device:([^\s]+)/);
      const productMatch = line.match(/product:([^\s]+)/);
      return {
        raw: line,
        state,
        model: modelMatch ? modelMatch[1] : null,
        device: deviceMatch ? deviceMatch[1] : null,
        product: productMatch ? productMatch[1] : null,
      };
    })
    .filter(Boolean);

  const xiaomiPad6Detected = devices.some(
    (d) =>
      d.state === "device" &&
      (d.device === "pipa" || d.model === "23043RP34G" || /pipa/i.test(d.product || ""))
  );

  return {
    deviceCount: devices.length,
    xiaomiPad6Detected,
    devices,
  };
}

function runCliVerification(rootDir = path.resolve(__dirname, "..")) {
  const workflowPath = path.join(rootDir, ".github", "workflows", "android-release.yml");
  const apkPath = path.join(
    rootDir,
    "mobile-app",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "release",
    "app-release.apk"
  );

  const workflow = verifyAndroidReleaseWorkflow(workflowPath);
  const apk = verifyReleaseApkArtifact(apkPath);

  let adbRaw = "";
  try {
    adbRaw = execSync("adb devices -l", { encoding: "utf8", timeout: 5000 });
  } catch (err) {
    adbRaw = "";
  }
  const adb = parseAdbDevicesOutput(adbRaw);

  return {
    checkedAt: new Date().toISOString(),
    workflow,
    apk,
    adb,
  };
}

if (require.main === module) {
  const report = runCliVerification();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.workflow.ok && report.apk.exists ? 0 : 1);
}

module.exports = {
  verifyAndroidReleaseWorkflow,
  verifyReleaseApkArtifact,
  parseAdbDevicesOutput,
  runCliVerification,
};
