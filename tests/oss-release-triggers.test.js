import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const {
  verifyAndroidReleaseWorkflow,
  verifyReleaseApkArtifact,
} = require("../mobile-app/verify-apk-release.cjs");

function extractPushTags(yamlText) {
  const match = yamlText.match(/on:\s*\r?\n\s*push:\s*\r?\n\s*tags:\s*\r?\n((?:\s+-\s+[^\r\n]+\r?\n?)+)/);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ""));
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesTagPatterns(tag, patterns) {
  let matched = false;
  for (const pat of patterns) {
    if (pat.startsWith("!")) {
      if (globToRegex(pat.slice(1)).test(tag)) matched = false;
    } else if (globToRegex(pat).test(tag)) {
      matched = true;
    }
  }
  return matched;
}

test("OSS baseline tag does not trigger Android APK or npm/GitHub Release workflows", () => {
  const androidYml = fs.readFileSync(path.join(ROOT, ".github/workflows/android-release.yml"), "utf8");
  const releaseYml = fs.readFileSync(path.join(ROOT, ".github/workflows/github-release.yml"), "utf8");

  const androidTags = extractPushTags(androidYml);
  const releaseTags = extractPushTags(releaseYml);

  assert.equal(matchesTagPatterns("v1.31.0-oss.0", androidTags), false);
  assert.equal(matchesTagPatterns("v1.31.0", androidTags), false);
  assert.equal(matchesTagPatterns("mobile-v1.31.0", androidTags), true);
  assert.equal(matchesTagPatterns("android-v1.0.0", androidTags), true);

  assert.equal(matchesTagPatterns("v1.31.0-oss.0", releaseTags), false);
  assert.equal(matchesTagPatterns("v1.31.0", releaseTags), true);
});

test("Android release workflow prepares Expo native project, handles missing android dir, and enforces signing/SHA-256", () => {
  const workflowPath = path.join(ROOT, ".github/workflows/android-release.yml");
  const content = fs.readFileSync(workflowPath, "utf8");

  assert.equal(verifyAndroidReleaseWorkflow(workflowPath).ok, true);
  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /npx expo prebuild --platform android/);
  assert.match(content, /if \[ ! -d "android" \]/);
  assert.match(content, /test -f android\/gradlew/);
  assert.match(content, /apksigner/);
  assert.match(content, /sha256sum app-release\.apk > app-release\.apk\.sha256/);
  assert.doesNotMatch(content, /100\.(?:77|107)\.\d+\.\d+/);
  assert.doesNotMatch(content, /storePassword\s+['"][^'"]+['"]/);
});

test("APK verification rejects non-ZIP artifacts and computes SHA-256 for valid APKs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwf-oss-apk-"));
  try {
    const invalid = path.join(tmpDir, "invalid.apk");
    fs.writeFileSync(invalid, Buffer.from("not-an-apk"));
    const invalidRes = verifyReleaseApkArtifact(invalid);
    assert.equal(invalidRes.exists, true);
    assert.equal(invalidRes.validZipHeader, false);

    const valid = path.join(tmpDir, "valid.apk");
    const buf = Buffer.alloc(64, 0x41);
    buf[0] = 0x50;
    buf[1] = 0x4b;
    buf[2] = 0x03;
    buf[3] = 0x04;
    fs.writeFileSync(valid, buf);
    const validRes = verifyReleaseApkArtifact(valid);
    assert.equal(validRes.validZipHeader, true);
    assert.match(validRes.sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CI workflow remains intact on clean-history baseline", () => {
  const ciYml = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ciYml, /branches:\s*\[main\]|-\s*main/);
  assert.match(ciYml, /npm run ci:test/);
});
