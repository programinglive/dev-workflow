import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Pemilik meminta (2 November 2026): "setiap task mesti ada counter timenya
 * biar tau berapa lama task itu selesai".
 *
 * MASALAH NYATA: `this.sessionStartedAt` dibaca di dua tempat
 * (`buildSnapshot` dan `save`) tetapi tidak pernah diisi, sehingga `started_at`
 * di dashboard selalu kosong dan durasi task mustahil dihitung.
 */

test("sesi baru punya waktu mulai yang bisa dipakai untuk timer", async () => {
  const { WorkflowState } = await import("../workflow-state.js");
  const sebelum = Date.now();
  const ws = new WorkflowState();
  const sesudah = Date.now();

  assert.equal(typeof ws.sessionStartedAt, "string");
  const ms = Date.parse(ws.sessionStartedAt);
  assert.ok(Number.isFinite(ms), "sessionStartedAt harus waktu yang sah");
  assert.ok(
    ms >= sebelum - 1000 && ms <= sesudah + 1000,
    "sessionStartedAt harus waktu saat objek dibuat",
  );
});

test("snapshot membawa startedAt sehingga dashboard bisa menghitung durasi", async () => {
  const { WorkflowState } = await import("../workflow-state.js");
  const { buildSnapshot } = await import("../monitor.js");
  const ws = new WorkflowState();

  const snap = buildSnapshot({
    state: { ...ws.state, currentPhase: "coding", taskDescription: "uji" },
    sessionKey: "ses_uji",
    projectPath: "D:\\code\\contoh",
    sessionStartedAt: ws.sessionStartedAt,
  });

  assert.equal(typeof snap.startedAt, "string");
  assert.ok(Number.isFinite(Date.parse(snap.startedAt)));
  // Nama proyek juga harus ikut, karena itu yang diminta tampil di kartu.
  assert.equal(snap.projectName, "contoh");
});
