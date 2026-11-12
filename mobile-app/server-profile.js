/**
 * DevWorkflow Mobile Companion — Runtime Server Profile Store & Domain Logic
 *
 * Provides headless server URL normalization, profile storage, active selection,
 * and ping/health probing without hardcoding server addresses at compile time.
 */

const STORAGE_KEY = "devwf_server_profiles_v1";
const ACTIVE_ID_KEY = "devwf_active_profile_id_v1";

/**
 * Normalizes a user-provided or discovered server address string.
 * Supports "100.77.138.14:3100", "localhost:3100", "https://host:port/path".
 *
 * @param {string} rawInput
 * @returns {{ ok: boolean, url?: string, host?: string, isSecure?: boolean, error?: string }}
 */
export function normalizeServerUrl(rawInput) {
  if (!rawInput || typeof rawInput !== "string") {
    return { ok: false, error: "Server URL cannot be empty." };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "Server URL cannot be whitespace." };
  }

  // Prepend protocol if missing
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    // If input starts with an unsupported protocol like ftp://, reject
    if (/^[a-z0-9+-.]+:\/\//i.test(candidate)) {
      return { ok: false, error: "Only http:// and https:// protocols are supported." };
    }
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, error: "Only http:// and https:// protocols are supported." };
    }

    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { ok: false, error: "Invalid host address." };
    }

    // Strip trailing slash and sub-paths from the base monitor origin
    // DevWorkflow Monitor API runs at root origin + port (e.g. http://host:3100)
    const portPart = parsed.port ? `:${parsed.port}` : "";
    const cleanUrl = `${parsed.protocol}//${parsed.hostname}${portPart}`;
    const host = `${parsed.hostname}${portPart}`;
    const isSecure = parsed.protocol === "https:";

    return {
      ok: true,
      url: cleanUrl,
      host,
      isSecure,
    };
  } catch (err) {
    return { ok: false, error: `Invalid URL format: ${err.message}` };
  }
}

/**
 * Creates a validated server profile object.
 *
 * @param {{ name?: string, url: string, isDefault?: boolean }} params
 * @returns {{ id: string, name: string, url: string, isDefault: boolean, createdAt: string, lastConnectedAt: string | null }}
 */
export function createProfile({ name, url, isDefault = false }) {
  const norm = normalizeServerUrl(url);
  if (!norm.ok) {
    throw new Error(norm.error);
  }

  const cleanName = (typeof name === "string" && name.trim().length > 0) ? name.trim() : norm.host;
  const id = `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  return {
    id,
    name: cleanName,
    url: norm.url,
    isDefault: Boolean(isDefault),
    createdAt: new Date().toISOString(),
    lastConnectedAt: null,
  };
}

/**
 * Headless Server Profile Store with synchronous memory caching and optional
 * persistent adapter (e.g. AsyncStorage or local memory storage).
 */
export class ServerProfileStore {
  constructor({ storage = null } = {}) {
    this.storage = storage;
    this.profiles = [];
    this.activeId = null;

    this._hydrate();
  }

  _hydrate() {
    if (!this.storage) return;

    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.profiles = parsed;
        }
      }
      const rawActive = this.storage.getItem(ACTIVE_ID_KEY);
      if (rawActive) {
        this.activeId = String(rawActive);
      }
    } catch {
      // Ignore corrupted local storage gracefully
    }
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.profiles));
      if (this.activeId) {
        this.storage.setItem(ACTIVE_ID_KEY, this.activeId);
      }
    } catch {
      // Storage write error tolerated
    }
  }

  getProfiles() {
    return [...this.profiles];
  }

  getActiveProfile() {
    if (this.profiles.length === 0) return null;
    const match = this.profiles.find((p) => p.id === this.activeId);
    if (match) return match;

    const def = this.profiles.find((p) => p.isDefault);
    return def || this.profiles[0];
  }

  setActiveProfile(id) {
    const target = this.profiles.find((p) => p.id === id);
    if (!target) return false;
    this.activeId = target.id;
    this._persist();
    return true;
  }

  addProfile({ name, url, isDefault = false }) {
    const profile = createProfile({ name, url, isDefault });
    if (isDefault || this.profiles.length === 0) {
      this.profiles.forEach((p) => {
        p.isDefault = false;
      });
      profile.isDefault = true;
      this.activeId = profile.id;
    }
    this.profiles.push(profile);
    this._persist();
    return profile;
  }

  updateProfile(id, updates = {}) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return null;

    const existing = this.profiles[idx];
    let nextUrl = existing.url;
    if (updates.url && updates.url !== existing.url) {
      const norm = normalizeServerUrl(updates.url);
      if (!norm.ok) throw new Error(norm.error);
      nextUrl = norm.url;
    }

    const nextName = (typeof updates.name === "string" && updates.name.trim().length > 0)
      ? updates.name.trim()
      : existing.name;

    const updated = {
      ...existing,
      ...updates,
      url: nextUrl,
      name: nextName,
    };

    if (updates.isDefault) {
      this.profiles.forEach((p) => {
        p.isDefault = false;
      });
      updated.isDefault = true;
    }

    this.profiles[idx] = updated;
    this._persist();
    return updated;
  }

  deleteProfile(id) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;

    this.profiles.splice(idx, 1);
    if (this.activeId === id) {
      this.activeId = this.profiles.length > 0 ? this.profiles[0].id : null;
    }
    this._persist();
    return true;
  }

  resolveActiveUrl(fallbackUrl = "http://127.0.0.1:3100") {
    const active = this.getActiveProfile();
    return active ? active.url : fallbackUrl;
  }
}

/**
 * Probes a candidate server URL to verify connectivity and latency.
 *
 * @param {string} serverUrl
 * @param {Function} [fetchFn]
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ ok: boolean, latencyMs: number | null, serverTime: string | null, error: string | null }>}
 */
export async function testServerConnection(serverUrl, fetchFn = globalThis.fetch, timeoutMs = 3000) {
  const norm = normalizeServerUrl(serverUrl);
  if (!norm.ok) {
    return { ok: false, latencyMs: null, serverTime: null, error: norm.error };
  }

  const start = Date.now();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchFn(`${norm.url}/health`, {
      method: "GET",
      headers: { "cache-control": "no-store" },
      signal: controller ? controller.signal : undefined,
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, serverTime: null, error: `HTTP ${res.status}` };
    }

    const json = await res.json().catch(() => ({}));
    return {
      ok: true,
      latencyMs,
      serverTime: json.at || new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    const isTimeout = err && err.name === "AbortError";
    return {
      ok: false,
      latencyMs: null,
      serverTime: null,
      error: isTimeout ? `Server did not respond within ${timeoutMs}ms` : (err.message || String(err)),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
