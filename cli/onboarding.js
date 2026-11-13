/**
 * Local-first onboarding and isolated Zettly profile management.
 *
 * Shared by `install.js`, the `devwf` CLI (`setup`, `zettly`, `doctor`), and
 * runtime credential resolution so CLI, installer, and MCP share one source of truth.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./args.js";
import { registerRuntimeSecret } from "../security/runtime-secrets.js";
import { readZettlyConfig, resolveZettlyConfig, zettlySyncEnabled } from "../zettly-client.js";

export const ONBOARDING_MODES = Object.freeze({
  LOCAL_FIRST_STANDALONE: "LOCAL_FIRST_STANDALONE",
  ZETTLY_SKIPPED: "ZETTLY_SKIPPED",
  ZETTLY_CONNECTED: "ZETTLY_CONNECTED",
  ZETTLY_DISCONNECTED: "ZETTLY_DISCONNECTED",
});

export function getProfileDir(env = process.env, home = os.homedir()) {
  const override = typeof env.DEVWF_PROFILE_DIR === "string" ? env.DEVWF_PROFILE_DIR.trim() : "";
  if (override) return path.resolve(override);
  return path.join(home, ".devworkflow");
}

export function getProfilePaths(env = process.env, home = os.homedir()) {
  const dir = getProfileDir(env, home);
  return {
    dir,
    profileFile: path.join(dir, "profile.json"),
    credentialsFile: path.join(dir, "zettly-credentials.json"),
  };
}

export function normalizeZettlyBaseUrl(rawUrl) {
  const text = String(rawUrl || "").trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (!["https:", "http:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  return text;
}

export function readOnboardingProfileSync(env = process.env, home = os.homedir()) {
  const { profileFile } = getProfilePaths(env, home);
  try {
    const raw = readFileSync(profileFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function readProfileCredentialsSync(env = process.env, home = os.homedir()) {
  const { credentialsFile } = getProfilePaths(env, home);
  try {
    const raw = readFileSync(credentialsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const base = normalizeZettlyBaseUrl(parsed.base);
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    if (!base || !token) return null;
    registerRuntimeSecret(token);
    return {
      base,
      token,
      expectedUserId: Number.isSafeInteger(Number(parsed.expectedUserId)) ? Number(parsed.expectedUserId) : undefined,
      accountLabel: typeof parsed.accountLabel === "string" ? parsed.accountLabel : "",
    };
  } catch {
    return null;
  }
}

export function detectExistingZettlyConnection({ env = process.env, home = os.homedir() } = {}) {
  const profile = readOnboardingProfileSync(env, home);
  const profileCreds = readProfileCredentialsSync(env, home);
  if (
    profile?.mode === ONBOARDING_MODES.ZETTLY_DISCONNECTED ||
    profile?.mode === ONBOARDING_MODES.ZETTLY_SKIPPED
  ) {
    return { connected: false, source: null, base: "", expectedUserId: undefined, accountLabel: "" };
  }
  if (profile?.mode === ONBOARDING_MODES.ZETTLY_CONNECTED || profileCreds) {
    return {
      connected: true,
      source: "devworkflow-profile",
      base: profileCreds?.base || profile?.zettly?.base || "",
      expectedUserId: profileCreds?.expectedUserId ?? profile?.zettly?.expectedUserId,
      accountLabel: profileCreds?.accountLabel || profile?.zettly?.accountLabel || "",
    };
  }

  // Detect existing legacy/workstation owner credentials without exposing tokens.
  const dpapiFile = path.join(home, ".zettly", "token.dpapi");
  let cliJson = {};
  try {
    cliJson = JSON.parse(readFileSync(path.join(home, ".zettly", "config.json"), "utf8"));
  } catch {
    cliJson = {};
  }
  const hasKeychain = cliJson?.managedOwnerCredential?.source === "macos-keychain";
  if (existsSync(dpapiFile) || hasKeychain) {
    return {
      connected: true,
      source: existsSync(dpapiFile) ? "windows-dpapi" : "macos-keychain",
      base: normalizeZettlyBaseUrl(cliJson?.host || ""),
      expectedUserId: cliJson?.managedOwnerCredential?.expectedUserId,
      accountLabel: cliJson?.managedOwnerCredential?.account || "",
    };
  }

  const legacyEnvFile = env.DEVWF_ZETTLY_CONFIG || path.join(env.LOCALAPPDATA || home, "DailyActivityJournal", "config.env");
  if (existsSync(legacyEnvFile)) {
    const legacy = readZettlyConfig(env);
    if (legacy) {
      return {
        connected: true,
        source: "legacy-config-file",
        base: legacy.base,
        expectedUserId: undefined,
        accountLabel: "",
      };
    }
  }

  return { connected: false, source: null, base: "", expectedUserId: undefined, accountLabel: "" };
}

async function writeProfile(paths, profile) {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.profileFile, JSON.stringify(profile, null, 2) + "\n", "utf8");
}

async function writeProfileCredentials(paths, creds) {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.credentialsFile, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(paths.credentialsFile, 0o600);
  } catch {
    // Windows filesystems may ignore POSIX chmod; directory isolation still applies.
  }
}

async function verifyZettlyIdentity({ base, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  registerRuntimeSecret(token);
  let response;
  try {
    response = await fetchImpl(`${base}/api/v1/user`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
  } catch {
    throw new CliError("Unable to reach Zettly server to verify account identity. Local workflow state was not modified.");
  }
  if (!response.ok) {
    throw new CliError(`Zettly authentication failed (HTTP ${response.status}). Local workflow state was not modified.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("Zettly returned an invalid identity response. Local workflow state was not modified.");
  }
  const user = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const userId = Number(user?.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new CliError("Zettly identity verification did not return a valid user id. Local workflow state was not modified.");
  }
  const accountLabel = String(user?.email || user?.username || user?.name || `user-${userId}`);
  return { userId, accountLabel };
}

export async function runOnboardingSetup({ env = process.env, home = os.homedir(), skipZettly = false, dryRun = false } = {}) {
  const paths = getProfilePaths(env, home);
  const existing = detectExistingZettlyConnection({ env, home });
  const currentProfile = readOnboardingProfileSync(env, home);

  if (existing.connected) {
    return {
      ok: true,
      action: "PRESERVED_EXISTING_CONNECTION",
      mode: ONBOARDING_MODES.ZETTLY_CONNECTED,
      source: existing.source,
      base: existing.base || undefined,
      expectedUserId: existing.expectedUserId,
      skipIgnoredBecauseConnected: Boolean(skipZettly),
      dryRun,
    };
  }

  const targetMode = skipZettly ? ONBOARDING_MODES.ZETTLY_SKIPPED : ONBOARDING_MODES.LOCAL_FIRST_STANDALONE;
  if (currentProfile?.mode === targetMode) {
    return {
      ok: true,
      action: "ALREADY_CONFIGURED",
      mode: currentProfile.mode,
      standalone: true,
      dryRun,
    };
  }

  const nextProfile = {
    version: 1,
    mode: targetMode,
    zettly: currentProfile?.zettly || null,
    updatedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    await writeProfile(paths, nextProfile);
  }
  return {
    ok: true,
    action: skipZettly ? "ZETTLY_SKIPPED" : "INITIALIZED_LOCAL_FIRST",
    mode: targetMode,
    standalone: true,
    dryRun,
  };
}

export async function skipZettlySetup({ env = process.env, home = os.homedir(), dryRun = false } = {}) {
  const existing = detectExistingZettlyConnection({ env, home });
  if (existing.connected) {
    throw new CliError(
      "Existing Zettly connection detected. 'skip' only applies when no account is connected; use 'devwf zettly disconnect --confirm' to disconnect."
    );
  }
  const paths = getProfilePaths(env, home);
  const current = readOnboardingProfileSync(env, home);
  const profile = {
    version: 1,
    mode: ONBOARDING_MODES.ZETTLY_SKIPPED,
    zettly: current?.zettly || null,
    updatedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    await writeProfile(paths, profile);
  }
  return {
    ok: true,
    action: "ZETTLY_SKIPPED",
    mode: ONBOARDING_MODES.ZETTLY_SKIPPED,
    standalone: true,
    dryRun,
  };
}

export async function connectZettlyAccount({
  env = process.env,
  home = os.homedir(),
  url,
  token,
  fetchImpl = fetch,
  dryRun = false,
} = {}) {
  const base = normalizeZettlyBaseUrl(url);
  if (!base) {
    throw new CliError("Provide a valid Zettly base URL with --url <https://...>.");
  }
  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    throw new CliError("Provide your personal Zettly token via interactive prompt, --token-stdin, or ZETTLY_API_TOKEN.");
  }
  registerRuntimeSecret(cleanToken);

  const existing = detectExistingZettlyConnection({ env, home });
  if (existing.connected) {
    throw new CliError(
      "A Zettly account is already connected. Use 'devwf zettly switch --url <url> --confirm' (with --token-stdin, ZETTLY_API_TOKEN, or interactive prompt) to switch accounts."
    );
  }

  const identity = await verifyZettlyIdentity({ base, token: cleanToken, fetchImpl });
  const paths = getProfilePaths(env, home);
  const current = readOnboardingProfileSync(env, home);
  const previousAccounts = Array.isArray(current?.zettly?.previousAccounts) ? current.zettly.previousAccounts : [];

  const profile = {
    version: 1,
    mode: ONBOARDING_MODES.ZETTLY_CONNECTED,
    zettly: {
      base,
      expectedUserId: identity.userId,
      accountLabel: identity.accountLabel,
      credentialSource: "devworkflow-profile",
      connectedAt: new Date().toISOString(),
      previousAccounts,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await writeProfileCredentials(paths, {
      base,
      token: cleanToken,
      expectedUserId: identity.userId,
      accountLabel: identity.accountLabel,
      updatedAt: profile.updatedAt,
    });
    await writeProfile(paths, profile);
  }

  return {
    ok: true,
    action: "ZETTLY_CONNECTED",
    mode: ONBOARDING_MODES.ZETTLY_CONNECTED,
    base,
    expectedUserId: identity.userId,
    accountLabel: identity.accountLabel,
    dryRun,
  };
}

export async function switchZettlyAccount({
  env = process.env,
  home = os.homedir(),
  url,
  token,
  confirm = false,
  fetchImpl = fetch,
  dryRun = false,
} = {}) {
  if (!confirm) {
    throw new CliError("Switching Zettly accounts requires --confirm so existing mappings are preserved as historical.");
  }
  const base = normalizeZettlyBaseUrl(url);
  if (!base) {
    throw new CliError("Provide a valid Zettly base URL with --url <https://...>.");
  }
  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    throw new CliError("Provide the new Zettly account token via interactive prompt, --token-stdin, or ZETTLY_API_TOKEN.");
  }
  registerRuntimeSecret(cleanToken);

  const identity = await verifyZettlyIdentity({ base, token: cleanToken, fetchImpl });
  const paths = getProfilePaths(env, home);
  const current = readOnboardingProfileSync(env, home);
  const existing = detectExistingZettlyConnection({ env, home });
  const previousAccounts = Array.isArray(current?.zettly?.previousAccounts) ? [...current.zettly.previousAccounts] : [];
  if (existing.connected && existing.expectedUserId !== undefined) {
    previousAccounts.push({
      base: existing.base,
      expectedUserId: existing.expectedUserId,
      accountLabel: existing.accountLabel,
      replacedAt: new Date().toISOString(),
    });
  }

  const profile = {
    version: 1,
    mode: ONBOARDING_MODES.ZETTLY_CONNECTED,
    zettly: {
      base,
      expectedUserId: identity.userId,
      accountLabel: identity.accountLabel,
      credentialSource: "devworkflow-profile",
      connectedAt: new Date().toISOString(),
      previousAccounts,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await writeProfileCredentials(paths, {
      base,
      token: cleanToken,
      expectedUserId: identity.userId,
      accountLabel: identity.accountLabel,
      updatedAt: profile.updatedAt,
    });
    await writeProfile(paths, profile);
  }

  return {
    ok: true,
    action: "ZETTLY_SWITCHED",
    mode: ONBOARDING_MODES.ZETTLY_CONNECTED,
    base,
    expectedUserId: identity.userId,
    accountLabel: identity.accountLabel,
    previousAccountPreservedAsHistory: true,
    dryRun,
  };
}

export async function disconnectZettlyAccount({ env = process.env, home = os.homedir(), confirm = false, dryRun = false } = {}) {
  if (!confirm) {
    throw new CliError("Disconnecting Zettly requires --confirm. Local task history and remote Todos are preserved.");
  }
  const paths = getProfilePaths(env, home);
  const current = readOnboardingProfileSync(env, home);
  const existing = detectExistingZettlyConnection({ env, home });
  const previousAccounts = Array.isArray(current?.zettly?.previousAccounts) ? [...current.zettly.previousAccounts] : [];
  if (existing.connected && existing.expectedUserId !== undefined) {
    previousAccounts.push({
      base: existing.base,
      expectedUserId: existing.expectedUserId,
      accountLabel: existing.accountLabel,
      disconnectedAt: new Date().toISOString(),
    });
  }

  const profile = {
    version: 1,
    mode: ONBOARDING_MODES.ZETTLY_DISCONNECTED,
    zettly: {
      base: "",
      expectedUserId: undefined,
      accountLabel: "",
      credentialSource: null,
      disconnectedAt: new Date().toISOString(),
      previousAccounts,
    },
    updatedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await rm(paths.credentialsFile, { force: true });
    await writeProfile(paths, profile);
  }

  return {
    ok: true,
    action: "ZETTLY_DISCONNECTED",
    mode: ONBOARDING_MODES.ZETTLY_DISCONNECTED,
    localHistoryPreserved: true,
    remoteTodosUntouched: true,
    dryRun,
  };
}

export async function getZettlyStatus({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  dpapiReader,
  keychainReader,
} = {}) {
  const profile = readOnboardingProfileSync(env, home);
  const existing = detectExistingZettlyConnection({ env, home });
  const syncEnabled = zettlySyncEnabled(env);
  const resolved = syncEnabled
    ? await resolveZettlyConfig(env, { platform, home, dpapiReader, keychainReader })
    : null;

  const mode = profile?.mode || (existing.connected ? ONBOARDING_MODES.ZETTLY_CONNECTED : ONBOARDING_MODES.LOCAL_FIRST_STANDALONE);
  return {
    ok: true,
    mode,
    standalone: !resolved && mode !== ONBOARDING_MODES.ZETTLY_CONNECTED,
    syncEnabled,
    connected: Boolean(resolved || mode === ONBOARDING_MODES.ZETTLY_CONNECTED),
    resolvedSource: resolved?.source || null,
    base: resolved?.base || existing.base || null,
    expectedUserId: resolved?.expectedUserId ?? existing.expectedUserId ?? null,
    accountLabel: profile?.zettly?.accountLabel || existing.accountLabel || null,
    tokenPresent: Boolean(resolved?.token),
  };
}

export async function runZettlyDoctor(opts = {}) {
  const status = await getZettlyStatus(opts);
  const env = opts.env || process.env;
  const profile = readOnboardingProfileSync(env, opts.home || os.homedir());
  const envExpected = env.ZETTLY_EXPECTED_USER_ID ? Number(env.ZETTLY_EXPECTED_USER_ID) : undefined;
  const profileExpected = profile?.zettly?.expectedUserId;
  const accountConflict =
    Boolean(envExpected && profileExpected && Number(envExpected) !== Number(profileExpected));

  return {
    ...status,
    ok: !accountConflict,
    accountConflict,
    checks: {
      standaloneSafe: status.standalone || status.connected,
      noRawTokenExposed: true,
      noAccountConflict: !accountConflict,
    },
  };
}
