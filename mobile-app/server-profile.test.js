import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeServerUrl,
  createProfile,
  ServerProfileStore,
  testServerConnection,
} from "./server-profile.js";

describe("server-profile domain logic", () => {
  describe("normalizeServerUrl", () => {
    it("normalizes a raw ip and port without protocol to http", () => {
      const res = normalizeServerUrl("127.0.0.1:3100");
      assert.equal(res.ok, true);
      assert.equal(res.url, "http://127.0.0.1:3100");
      assert.equal(res.host, "127.0.0.1:3100");
      assert.equal(res.isSecure, false);
    });

    it("preserves explicit https protocol and strips trailing slashes", () => {
      const res = normalizeServerUrl("https://monitor.example.com:8443/api/sessions/");
      assert.equal(res.ok, true);
      assert.equal(res.url, "https://monitor.example.com:8443");
      assert.equal(res.isSecure, true);
    });

    it("handles localhost with port correctly", () => {
      const res = normalizeServerUrl("localhost:3100");
      assert.equal(res.ok, true);
      assert.equal(res.url, "http://localhost:3100");
      assert.equal(res.host, "localhost:3100");
    });

    it("rejects invalid or empty url strings", () => {
      assert.equal(normalizeServerUrl("").ok, false);
      assert.equal(normalizeServerUrl("   ").ok, false);
      assert.equal(normalizeServerUrl(null).ok, false);
      assert.equal(normalizeServerUrl("not-a-valid-url:999999").ok, false);
      assert.equal(normalizeServerUrl("ftp://files.example.com").ok, false);
    });
  });

  describe("createProfile", () => {
    it("creates a well-formed profile object", () => {
      const prof = createProfile({
        name: "Desk Workstation",
        url: "http://192.168.1.100:3100",
        isDefault: true,
      });
      assert.ok(prof.id.startsWith("prof_"));
      assert.equal(prof.name, "Desk Workstation");
      assert.equal(prof.url, "http://192.168.1.100:3100");
      assert.equal(prof.isDefault, true);
      assert.ok(prof.createdAt);
    });

    it("falls back to host as name when name is empty", () => {
      const prof = createProfile({ url: "10.0.0.5:3100" });
      assert.equal(prof.name, "10.0.0.5:3100");
      assert.equal(prof.url, "http://10.0.0.5:3100");
    });
  });

  describe("ServerProfileStore", () => {
    let store;
    let mockStorage;

    beforeEach(() => {
      const state = {};
      mockStorage = {
        getItem: (k) => state[k] || null,
        setItem: (k, v) => {
          state[k] = v;
        },
      };
      store = new ServerProfileStore({ storage: mockStorage });
    });

    it("initializes empty and returns fallback url when no profiles exist", () => {
      assert.deepEqual(store.getProfiles(), []);
      assert.equal(store.resolveActiveUrl("http://fallback:3100"), "http://fallback:3100");
    });

    it("adds a profile, saves to storage, and activates it if first", () => {
      const p1 = store.addProfile({ name: "Primary", url: "http://server1:3100" });
      assert.equal(store.getProfiles().length, 1);
      assert.equal(store.getActiveProfile().id, p1.id);
      assert.equal(store.resolveActiveUrl(), "http://server1:3100");
    });

    it("allows switching active profile", () => {
      const p1 = store.addProfile({ name: "P1", url: "http://server1:3100" });
      const p2 = store.addProfile({ name: "P2", url: "http://server2:3100" });
      assert.equal(store.getActiveProfile().id, p1.id);

      store.setActiveProfile(p2.id);
      assert.equal(store.getActiveProfile().id, p2.id);
      assert.equal(store.resolveActiveUrl(), "http://server2:3100");
    });

    it("updates existing profile attributes", () => {
      const p = store.addProfile({ name: "Old", url: "http://old:3100" });
      const updated = store.updateProfile(p.id, { name: "Renamed", url: "https://new:443" });
      assert.equal(updated.name, "Renamed");
      assert.equal(updated.url, "https://new");
      assert.equal(store.getActiveProfile().url, "https://new");
    });

    it("deletes a profile and falls back to remaining profile", () => {
      const p1 = store.addProfile({ name: "P1", url: "http://server1:3100" });
      const p2 = store.addProfile({ name: "P2", url: "http://server2:3100" });
      store.setActiveProfile(p1.id);

      store.deleteProfile(p1.id);
      assert.equal(store.getProfiles().length, 1);
      assert.equal(store.getActiveProfile().id, p2.id);
    });

    it("reloads persisted state from storage on construction", () => {
      store.addProfile({ name: "Persisted", url: "http://saved:3100" });
      const store2 = new ServerProfileStore({ storage: mockStorage });
      assert.equal(store2.getProfiles().length, 1);
      assert.equal(store2.getActiveProfile().name, "Persisted");
    });
  });

  describe("testServerConnection", () => {
    it("returns ok with latency when endpoint responds with 200", async () => {
      const mockFetch = async (url) => {
        assert.equal(url, "http://server:3100/health");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, at: "2026-11-12T12:00:00Z" }),
        };
      };
      const res = await testServerConnection("http://server:3100", mockFetch, 500);
      assert.equal(res.ok, true);
      assert.equal(typeof res.latencyMs, "number");
      assert.equal(res.serverTime, "2026-11-12T12:00:00Z");
    });

    it("returns error when server returns 500 or network fails", async () => {
      const mockFetch = async () => {
        throw new Error("Connection refused");
      };
      const res = await testServerConnection("http://bad-server:3100", mockFetch, 500);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("Connection refused"));
    });
  });
});
