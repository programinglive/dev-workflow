import { test } from "node:test";
import assert from "node:assert";

import { startKeeping, stopKeeping, currentSession, beatOnce } from "../session-keeper.js";

// Sesi kerja harus dilaporkan hidup selama proses ini masih memegangnya.
// Tanpa itu, setiap task yang diambil lewat MCP langsung tampil "tidak ada
// kabar" di papan padahal sedang dikerjakan.
const CONFIG = { url: "https://factory.test", token: "tok-1", pocketBaseUrl: "https://pb.test", machineId: "box", agent: "agent" };
const SESSION = { id: "sess-9", device: { id: "d1", name: "box" } };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    for (const handler of handlers) {
      const result = handler(calls.at(-1));
      if (result) return result;
    }
    return json({ session: { id: "sess-9", state: "active" } });
  };
  impl.calls = calls;
  return impl;
}

test("keeper mengirim heartbeat berkala selama sesi dipegang", async () => {
  stopKeeping();
  const fetchImpl = fakeFetch([]);
  startKeeping(CONFIG, SESSION, "Menulis kode", { fetchImpl, intervalMs: 15 });

  await new Promise((resolve) => setTimeout(resolve, 60));
  stopKeeping();

  const beats = fetchImpl.calls.filter((call) => call.body?.action === "heartbeat");
  assert.ok(beats.length >= 2, `harus ada heartbeat berulang, dapat ${beats.length}`);
  assert.strictEqual(beats[0].body.sessionId, "sess-9");
  assert.strictEqual(beats[0].body.deviceId, "d1");
  assert.strictEqual(beats[0].body.step, "Menulis kode");
});

test("stopKeeping menghentikan heartbeat, jadi sesi bisa jadi stale lagi", async () => {
  stopKeeping();
  const fetchImpl = fakeFetch([]);
  startKeeping(CONFIG, SESSION, "Selesai", { fetchImpl, intervalMs: 15 });

  await new Promise((resolve) => setTimeout(resolve, 40));
  stopKeeping();
  const afterStop = fetchImpl.calls.length;

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(fetchImpl.calls.length, afterStop, "tidak boleh ada heartbeat setelah dihentikan");
  assert.strictEqual(currentSession(), null);
});

test("keeper berhenti sendiri saat sesi sudah diambil alih atau berakhir", async () => {
  stopKeeping();
  // 409 = sesi milik perangkat lain / sudah berakhir. Keeper tidak boleh
  // melawan; kalau terus mencoba, ia bertengkar dengan pemegang baru.
  const fetchImpl = fakeFetch([() => json({ error: "Sesi sudah berakhir." }, 409)]);
  startKeeping(CONFIG, SESSION, "Dikerjakan", { fetchImpl, intervalMs: 10 });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const attempts = fetchImpl.calls.length;

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(fetchImpl.calls.length, attempts, "setelah 409 keeper harus berhenti");
  assert.strictEqual(currentSession(), null);
  stopKeeping();
});

test("beatOnce tidak melakukan apa pun tanpa sesi aktif", async () => {
  stopKeeping();
  const fetchImpl = fakeFetch([]);
  await beatOnce({ fetchImpl });
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test("startKeeping mengganti sesi sebelumnya, bukan menjalankan dua sekaligus", async () => {
  stopKeeping();
  const fetchImpl = fakeFetch([]);
  startKeeping(CONFIG, SESSION, "Pertama", { fetchImpl, intervalMs: 10 });
  startKeeping(CONFIG, { id: "sess-2", device: { id: "d2" } }, "Kedua", { fetchImpl, intervalMs: 10 });

  await new Promise((resolve) => setTimeout(resolve, 45));
  stopKeeping();

  const ids = new Set(fetchImpl.calls.map((call) => call.body?.sessionId));
  assert.deepStrictEqual([...ids], ["sess-2"], "hanya sesi terbaru yang boleh di-heartbeat");
});
