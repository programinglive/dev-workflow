import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, reportSnapshot, reportEvent } from "../monitor.js";

/**
 * Laporan ke monitor pusat TIDAK BOLEH menggagalkan pekerjaan.
 *
 * Aturan itu mudah dilanggar tanpa sengaja: satu `fetch` yang melempar di
 * dalam `save()` akan menghentikan commit, dan penyebabnya tidak terlihat
 * karena monitor hanyalah fitur pinggiran.
 */

const ENV = { DEVWF_MONITOR_URL: "http://127.0.0.1:3100" };

const state = {
  taskDescription: "Perbaiki retry",
  taskType: "bugfix",
  currentPhase: "testing",
  definitionOfDone: [
    { id: "dod-1", text: "a", status: "done", revision: 2 },
    { id: "dod-2", text: "b", status: "open", revision: 0 },
    { id: "dod-3", text: "c", status: "waived", revision: 0 },
  ],
  dodRevision: 2,
  plan: [
    { id: "plan-1", text: "telusuri", status: "done" },
    { id: "plan-2", text: "implementasi", status: "open" },
  ],
  owner: { pid: 1234 },
};

test("buildSnapshot merangkum sesi tanpa isi berkas", () => {
  const s = buildSnapshot({ state, sessionKey: "ses_X", projectPath: "D:\\code\\clinic", env: {} });
  assert.equal(s.sessionKey, "ses_X");
  assert.equal(s.projectName, "clinic");
  assert.equal(s.task, "Perbaiki retry");
  assert.equal(s.phase, "testing");
  assert.equal(s.planDone, 1);
  assert.equal(s.planTotal, 2);
  assert.equal(s.dodDone, 1, "hanya bukti pada revisi berlaku yang dihitung");
  assert.equal(s.dodWaived, 1);
  assert.equal(s.dodTotal, 3);
  assert.equal(s.ownerPid, 1234);
  assert.equal(JSON.stringify(s).includes("evidence"), false);
});

test("buildSnapshot aman untuk state kosong", () => {
  const s = buildSnapshot({ env: {} });
  assert.equal(s.phase, "idle");
  assert.equal(s.planTotal, 0);
  assert.equal(s.dodTotal, 0);
  assert.equal(s.task, "");
});

test("buildSnapshot menggunakan sessionTitle bila ada atau jatuh ke taskDescription", () => {
  const sWithTask = buildSnapshot({ state, sessionKey: "ses_tanpa_db", env: {} });
  assert.equal(sWithTask.sessionTitle, "Perbaiki retry");

  const sEmpty = buildSnapshot({ state: {}, sessionKey: "ses_tanpa_db", env: {} });
  assert.equal(sEmpty.sessionTitle, "");
});

test("reportSnapshot tidak melakukan apa pun tanpa URL", async () => {
  let called = false;
  const ok = await reportSnapshot({
    env: {},
    snapshot: buildSnapshot({ state, env: {} }),
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(ok, false);
  assert.equal(called, false, "tanpa URL tidak boleh ada permintaan jaringan sama sekali");
});

test("reportSnapshot menelan kegagalan jaringan", async () => {
  const ok = await reportSnapshot({
    env: ENV,
    snapshot: buildSnapshot({ state, env: ENV }),
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(ok, false, "gagal kirim bukan alasan melempar");
});

test("reportSnapshot mengirim ke /api/session dengan JSON", async () => {
  let seen = null;
  const ok = await reportSnapshot({
    env: ENV,
    snapshot: buildSnapshot({ state, sessionKey: "ses_X", env: ENV }),
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true }; },
  });
  assert.equal(ok, true);
  assert.match(seen.url, /\/api\/session$/);
  assert.equal(seen.opts.method, "POST");
  assert.equal(JSON.parse(seen.opts.body).sessionKey, "ses_X");
});

test("reportEvent menolak peristiwa tanpa kind", async () => {
  let called = false;
  const ok = await reportEvent({
    env: ENV,
    event: { detail: "tanpa kind" },
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("reportEvent menelan kegagalan jaringan", async () => {
  const ok = await reportEvent({
    env: ENV,
    event: { kind: "task_started", detail: "x" },
    fetchImpl: async () => { throw new Error("timeout"); },
  });
  assert.equal(ok, false);
});
