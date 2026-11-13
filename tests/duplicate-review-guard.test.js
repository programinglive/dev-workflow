import { test } from "node:test";
import assert from "node:assert";

import { updateTaskStatus } from "../factory-client.js";

// Kenapa tes ini ada:
//
// Pada 29 Oktober 2026 empat task melompat ke `done` tanpa persetujuan pemilik.
// Penyebabnya state desync: sesi kerja lama sudah berstatus `review`, sementara
// task di board masih `backlog`. Agen lalu claim (sesi baru) dan melaporkan
// `review` lagi. Factory membaca laporan review kedua itu sebagai APPROVAL.
//
// Karena itu finish dengan outcome `review` harus ditolak bila task sudah punya
// riwayat review. Menolak di klien lebih baik daripada bergantung pada perilaku
// server yang tidak terdokumentasi.

const TASK_ID = "55555555-5555-4555-8555-555555555555";

const CONFIG = {
  url: "https://factory.test",
  token: "tok-1",
  pocketBaseUrl: "https://pb.test",
  deviceId: "d1",
  machineId: "box",
  agent: "agent",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const entry = {
      url: String(url),
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
      headers: options.headers || {},
    };
    calls.push(entry);
    for (const handler of handlers) {
      const result = handler(entry);
      if (result) return result;
    }
    return json({ error: "unexpected call" }, 500);
  };
  impl.calls = calls;
  return impl;
}

const ACTIVE_TASK = {
  id: TASK_ID,
  projectId: "p1",
  title: "Pulihkan monitoring & alerting db-host.example",
  status: "running",
  priority: "high",
  work: { id: "sess-new", state: "active", step: "verifikasi" },
};

function workspaceWith(events) {
  return { projects: [{ id: "p1", name: "mahatmamahardhikach/bw-server-grooming" }], tasks: [ACTIVE_TASK], events };
}

/**
 * The real work session, as `GET /api/work` returns it.
 *
 * The workspace payload only carries a badge (no `id`, no `state`), so the
 * client reads the session from this endpoint before it can finish anything.
 */
function workSessionsResponse() {
  return json({
    sessions: [{ id: "sess-new", taskId: TASK_ID, state: "active", device: { id: "d1" } }],
    staleAfterSeconds: 120,
  });
}

test("menolak finish review bila task sudah punya riwayat work.review", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              {
                id: "ev-1",
                kind: "work.review",
                targetId: TASK_ID,
                message: "Sesi review: SELESAI 29 Okt 09:55 WIB.",
                createdAt: "2026-10-29T02:59:26.348Z",
              },
            ]),
          )
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-new", state: "review" } }) : null),
  ]);

  await assert.rejects(
    () => updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl),
    /review/i,
    "harus menolak, bukan mengirim finish yang dibaca Factory sebagai approval",
  );

  const posted = fetchImpl.calls.filter((call) => call.url.endsWith("/api/work"));
  assert.strictEqual(posted.length, 0, "tidak boleh ada POST /api/work saat ditolak");
});

test("menolak finish review bila task sudah pernah done", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              { id: "ev-2", kind: "task.done", targetId: TASK_ID, message: "Task disetujui.", createdAt: "2026-10-29T03:00:00.000Z" },
            ]),
          )
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) => (call.url.endsWith("/api/work") && call.method === "POST" ? json({ session: { id: "sess-new", state: "review" } }) : null),
  ]);

  await assert.rejects(
    () => updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl),
    /review/i,
  );
});

test("pesan penolakan menyebut langkah berikutnya, bukan hanya melarang", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              { id: "ev-3", kind: "work.review", targetId: TASK_ID, message: "Sesi review lama.", createdAt: "2026-10-29T02:59:26.348Z" },
            ]),
          )
        : null,
  ]);

  await assert.rejects(
    () => updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl),
    (error) => {
      assert.match(error.message, /pemilik|owner/i, "harus menyebut pemilik/owner");
      assert.match(error.message, /done/i, "harus menyebut keputusan done");
      return true;
    },
  );
});

test("riwayat review milik task LAIN tidak ikut memblokir", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              {
                id: "ev-4",
                kind: "work.review",
                targetId: "99999999-9999-4999-8999-999999999999",
                message: "Sesi review task lain.",
                createdAt: "2026-10-29T02:00:00.000Z",
              },
            ]),
          )
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) =>
      call.url.endsWith("/api/work") && call.method === "POST"
        ? json({ session: { id: "sess-new", state: "review", summary: "Selesai." } })
        : null,
  ]);

  const result = await updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl);

  assert.strictEqual(result.status, "review");
  const finish = fetchImpl.calls.find((call) => call.url.endsWith("/api/work") && call.method === "POST");
  assert.strictEqual(finish.body.outcome, "review");
});

test("workspace tanpa array events tetap boleh finish review", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json({ projects: [], tasks: [ACTIVE_TASK] })
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) =>
      call.url.endsWith("/api/work") && call.method === "POST"
        ? json({ session: { id: "sess-new", state: "review" } })
        : null,
  ]);

  const result = await updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl);

  assert.strictEqual(result.status, "review");
});

test("outcome blocked tidak terpengaruh riwayat review", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              { id: "ev-5", kind: "work.review", targetId: TASK_ID, message: "Sesi review lama.", createdAt: "2026-10-29T02:59:26.348Z" },
            ]),
          )
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) =>
      call.url.endsWith("/api/work") && call.method === "POST"
        ? json({ session: { id: "sess-new", state: "blocked" } })
        : null,
  ]);

  const result = await updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "blocked", reason: "Butuh akses." }, fetchImpl);

  assert.strictEqual(result.status, "blocked");
});

test("review setelah work.paused boleh: pekerjaan memang dikerjakan ulang", async () => {
  // Alur sah: review -> pemilik menolak -> sesi di-pause (jalan satu-satunya
  // untuk kembali ke backlog) -> dikerjakan lagi -> dilaporkan review lagi.
  // Tanpa pengecualian ini, penjaga akan memblokir pekerjaan ulang selamanya.
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              { id: "ev-6", kind: "work.review", targetId: TASK_ID, message: "Sesi review pertama.", createdAt: "2026-10-29T02:00:00.000Z" },
              { id: "ev-7", kind: "work.paused", targetId: TASK_ID, message: "Dikembalikan: perlu perbaikan.", createdAt: "2026-10-29T03:00:00.000Z" },
            ]),
          )
        : null,
    (call) => (call.url.endsWith("/api/work") && call.method === "GET" ? workSessionsResponse() : null),
    (call) =>
      call.url.endsWith("/api/work") && call.method === "POST"
        ? json({ session: { id: "sess-new", state: "review" } })
        : null,
  ]);

  const result = await updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Sudah diperbaiki." }, fetchImpl);

  assert.strictEqual(result.status, "review");
});

test("review setelah paused lalu review lagi tetap diblokir", async () => {
  const fetchImpl = fakeFetch([
    (call) =>
      call.url.endsWith("/api/factory")
        ? json(
            workspaceWith([
              { id: "ev-8", kind: "work.paused", targetId: TASK_ID, message: "Dikembalikan.", createdAt: "2026-10-29T02:00:00.000Z" },
              { id: "ev-9", kind: "work.review", targetId: TASK_ID, message: "Sesi review kedua.", createdAt: "2026-10-29T03:00:00.000Z" },
            ]),
          )
        : null,
  ]);

  await assert.rejects(
    () => updateTaskStatus(CONFIG, { recordId: TASK_ID, status: "review", reason: "Selesai." }, fetchImpl),
    /review/i,
  );
});
