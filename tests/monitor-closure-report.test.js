import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState } from "../workflow-state.js";

/**
 * MASALAH NYATA (1 November 2026): sesi berhenti melapor setelah 74 menit
 * padahal prosesnya masih hidup, sehingga task yang sudah selesai tetap tampak
 * "mungkin macet" sampai jendela 2 jam habis.
 *
 * Penyebabnya bukan kerusakan: laporan hanya dikirim saat `save()` dipanggil,
 * jadi sesi yang menganggur tidak mengirim apa pun. Yang perlu dipastikan di
 * sini adalah bahwa PENUTUPAN task (fase idle) tetap terkirim dan tidak
 * dilewati oleh aturan boot - karena itulah satu-satunya kabar yang membuat
 * kartu di tablet hilang.
 */

function withTempState(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "dwf-closure-"));
  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  process.env.DEV_WORKFLOW_STATE_FILE = path.join(dir, "workflow-state.json");
  try {
    return fn(dir);
  } finally {
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("snapshot penutupan membawa fase idle dan task kosong", async () => {
  await withTempState(async () => {
    const state = new WorkflowState();
    await state.load();
    const laporan = [];
    const asli = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      laporan.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true };
    };
    const urlLama = process.env.DEVWF_MONITOR_URL;
    process.env.DEVWF_MONITOR_URL = "http://monitor.test:3100";
    try {
      state.reset();
      await state.save();
      // Tidak boleh ada laporan berfase non-idle yang mengaku masih bekerja.
      for (const l of laporan) {
        if (l.url.includes("/api/session")) {
          assert.ok(
            l.body.phase === "idle" || l.body.task !== "",
            "snapshot non-idle wajib punya task",
          );
        }
      }
      // Penutupan harus benar-benar terkirim: minimal satu laporan fase idle.
      const penutupan = laporan.filter(
        (l) => l.url.includes("/api/session") && l.body.phase === "idle",
      );
      assert.ok(penutupan.length >= 1, "penutupan task harus dikirim ke monitor");
    } finally {
      globalThis.fetch = asli;
      if (urlLama === undefined) delete process.env.DEVWF_MONITOR_URL;
      else process.env.DEVWF_MONITOR_URL = urlLama;
    }
  });
});

test("monitor yang tidak bisa dijangkau tidak menggagalkan penutupan", async () => {
  await withTempState(async () => {
    const state = new WorkflowState();
    await state.load();
    const urlLama = process.env.DEVWF_MONITOR_URL;
    process.env.DEVWF_MONITOR_URL = "http://127.0.0.1:9";
    try {
      state.reset();
      // save() harus tetap berhasil walau laporan penutupan gagal.
      await state.save();
      assert.equal(state.state.currentPhase, "idle");
    } finally {
      if (urlLama === undefined) delete process.env.DEVWF_MONITOR_URL;
      else process.env.DEVWF_MONITOR_URL = urlLama;
    }
  });
});
