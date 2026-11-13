import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ONBOARDING_MODES,
  connectZettlyAccount,
  disconnectZettlyAccount,
  getZettlyStatus,
  runOnboardingSetup,
  runZettlyDoctor,
  skipZettlySetup,
  switchZettlyAccount,
} from "../cli/onboarding.js";
import { parseArgs } from "../cli/args.js";
import { resolveZettlyConfig } from "../zettly-client.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function makeUserFetch(id, email) {
  return async (url) => {
    assert.ok(url.endsWith("/api/v1/user"), `Unexpected URL: ${url}`);
    return new Response(JSON.stringify({ success: true, data: { id, email } }), { status: 200 });
  };
}

test("Test A — No Zettly: fresh install defaults to LOCAL_FIRST_STANDALONE with zero Zettly dependency", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-a-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    const res = await runOnboardingSetup({ env, home: dir });
    assert.equal(res.ok, true);
    assert.equal(res.mode, ONBOARDING_MODES.LOCAL_FIRST_STANDALONE);
    assert.equal(res.standalone, true);

    const resolved = await resolveZettlyConfig(env, { home: dir, platform: "linux" });
    assert.equal(resolved, null);

    const status = await getZettlyStatus({ env, home: dir, platform: "linux" });
    assert.equal(status.standalone, true);
    assert.equal(status.connected, false);
    assert.equal(status.tokenPresent, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test B — Skip: first-run Skip records ZETTLY_SKIPPED with zero network calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-b-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    const parsed = parseArgs(["setup", "--skip-zettly", "--json"]);
    assert.equal(parsed.command, "setup");
    assert.equal(parsed.skipZettly, true);

    const res = await runOnboardingSetup({ env, home: dir, skipZettly: true });
    assert.equal(res.mode, ONBOARDING_MODES.ZETTLY_SKIPPED);
    assert.equal(res.standalone, true);

    const resolved = await resolveZettlyConfig(env, { home: dir, platform: "linux" });
    assert.equal(resolved, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test C — Existing Connected User: reinstall or skip never resets an existing Zettly connection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-c-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    await connectZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-user.example",
      token: "synthetic-owner-token-c",
      fetchImpl: makeUserFetch(42, "owner@example.test"),
    });

    // Re-running setup with skipZettly=true MUST preserve existing connection
    const rerun = await runOnboardingSetup({ env, home: dir, skipZettly: true });
    assert.equal(rerun.action, "PRESERVED_EXISTING_CONNECTION");
    assert.equal(rerun.mode, ONBOARDING_MODES.ZETTLY_CONNECTED);
    assert.equal(rerun.expectedUserId, 42);
    assert.equal(rerun.skipIgnoredBecauseConnected, true);

    // Explicit `devwf zettly skip` MUST refuse when connected
    await assert.rejects(() => skipZettlySetup({ env, home: dir }), /Existing Zettly connection/);

    // Existing legacy DPAPI connection is also preserved
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-legacy-"));
    try {
      await mkdir(path.join(legacyDir, ".zettly"), { recursive: true });
      await writeFile(path.join(legacyDir, ".zettly", "token.dpapi"), "dpapi-encrypted");
      await writeFile(
        path.join(legacyDir, ".zettly", "config.json"),
        JSON.stringify({ host: "https://zettly.example", managedOwnerCredential: { expectedUserId: 1 } }),
      );
      const legacyEnv = { DEVWF_PROFILE_DIR: path.join(legacyDir, ".devworkflow") };
      const legacySetup = await runOnboardingSetup({ env: legacyEnv, home: legacyDir, skipZettly: true });
      assert.equal(legacySetup.action, "PRESERVED_EXISTING_CONNECTION");
      assert.equal(legacySetup.source, "windows-dpapi");
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test D — Multiple Developers: two isolated synthetic identities have zero cross-account leakage", async () => {
  const dirA = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-devA-"));
  const dirB = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-devB-"));
  try {
    const envA = { DEVWF_PROFILE_DIR: path.join(dirA, ".devworkflow") };
    const envB = { DEVWF_PROFILE_DIR: path.join(dirB, ".devworkflow") };

    await connectZettlyAccount({
      env: envA,
      home: dirA,
      url: "https://zettly-a.example",
      token: "synthetic-token-dev-a",
      fetchImpl: makeUserFetch(101, "deva@example.test"),
    });
    await connectZettlyAccount({
      env: envB,
      home: dirB,
      url: "https://zettly-b.example",
      token: "synthetic-token-dev-b",
      fetchImpl: makeUserFetch(202, "devb@example.test"),
    });

    const cfgA = await resolveZettlyConfig(envA, { home: dirA, platform: "linux" });
    const cfgB = await resolveZettlyConfig(envB, { home: dirB, platform: "linux" });
    assert.equal(cfgA.expectedUserId, 101);
    assert.equal(cfgA.token, "synthetic-token-dev-a");
    assert.equal(cfgB.expectedUserId, 202);
    assert.equal(cfgB.token, "synthetic-token-dev-b");
    assert.notEqual(cfgA.base, cfgB.base);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("Test E — Account Switching: requires --confirm, verifies identity, preserves prior history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-e-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    await connectZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-1.example",
      token: "synthetic-token-1",
      fetchImpl: makeUserFetch(11, "one@example.test"),
    });

    await assert.rejects(
      () =>
        switchZettlyAccount({
          env,
          home: dir,
          url: "https://zettly-2.example",
          token: "synthetic-token-2",
          confirm: false,
          fetchImpl: makeUserFetch(22, "two@example.test"),
        }),
      /--confirm/,
    );

    const switched = await switchZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-2.example",
      token: "synthetic-token-2",
      confirm: true,
      fetchImpl: makeUserFetch(22, "two@example.test"),
    });
    assert.equal(switched.action, "ZETTLY_SWITCHED");
    assert.equal(switched.expectedUserId, 22);
    assert.equal(switched.previousAccountPreservedAsHistory, true);

    const profile = JSON.parse(readFileSync(path.join(env.DEVWF_PROFILE_DIR, "profile.json"), "utf8"));
    assert.equal(profile.zettly.expectedUserId, 22);
    assert.equal(profile.zettly.previousAccounts.length, 1);
    assert.equal(profile.zettly.previousAccounts[0].expectedUserId, 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test F — Failure Recovery: invalid credentials or network errors preserve existing profile", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-f-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    await connectZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-good.example",
      token: "synthetic-good-token",
      fetchImpl: makeUserFetch(55, "good@example.test"),
    });

    await assert.rejects(
      () =>
        switchZettlyAccount({
          env,
          home: dir,
          url: "https://zettly-bad.example",
          token: "synthetic-bad-token",
          confirm: true,
          fetchImpl: async () => new Response("unauthorized", { status: 401 }),
        }),
      /HTTP 401/,
    );

    const cfg = await resolveZettlyConfig(env, { home: dir, platform: "linux" });
    assert.equal(cfg.expectedUserId, 55);
    assert.equal(cfg.token, "synthetic-good-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test G — Environment Precedence: conflicting ZETTLY_EXPECTED_USER_ID fails closed without silent switch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-g-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    await connectZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-g.example",
      token: "synthetic-g-token",
      fetchImpl: makeUserFetch(77, "g@example.test"),
    });

    const conflictEnv = { ...env, ZETTLY_EXPECTED_USER_ID: "999" };
    const resolved = await resolveZettlyConfig(conflictEnv, { home: dir, platform: "linux" });
    assert.equal(resolved, null);

    const diag = await runZettlyDoctor({ env: conflictEnv, home: dir, platform: "linux" });
    assert.equal(diag.ok, false);
    assert.equal(diag.accountConflict, true);
    assert.equal(JSON.stringify(diag).includes("synthetic-g-token"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test H — Package Security: zettly-client.js has no hardcoded owner host or keychain defaults", () => {
  const clientSrc = readFileSync(path.join(ROOT, "zettly-client.js"), "utf8");
  assert.equal(clientSrc.includes("zettly.programinglive.com"), false);
  assert.equal(clientSrc.includes("programinglive.zettly"), false);
  assert.equal(clientSrc.includes("zettly-owner"), false);
});

test("Test I & J — Reinstall Idempotency + Disconnect preserves local history and leaves remote untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devwf-oss-ij-"));
  try {
    const env = { DEVWF_PROFILE_DIR: path.join(dir, ".devworkflow") };
    const first = await runOnboardingSetup({ env, home: dir });
    const second = await runOnboardingSetup({ env, home: dir });
    assert.equal(first.action, "INITIALIZED_LOCAL_FIRST");
    assert.equal(second.action, "ALREADY_CONFIGURED");

    await connectZettlyAccount({
      env,
      home: dir,
      url: "https://zettly-ij.example",
      token: "synthetic-ij-token",
      fetchImpl: makeUserFetch(88, "ij@example.test"),
    });
    const disc = await disconnectZettlyAccount({ env, home: dir, confirm: true });
    assert.equal(disc.action, "ZETTLY_DISCONNECTED");
    assert.equal(disc.localHistoryPreserved, true);
    assert.equal(disc.remoteTodosUntouched, true);
    assert.equal(existsSync(path.join(env.DEVWF_PROFILE_DIR, "zettly-credentials.json")), false);

    const resolvedAfter = await resolveZettlyConfig(env, { home: dir, platform: "linux" });
    assert.equal(resolvedAfter, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
