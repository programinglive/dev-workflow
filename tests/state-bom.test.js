/**
 * Berkas state yang ditulis PowerShell diawali BOM (EF BB BF), dan JSON.parse
 * menolaknya. Kegagalan itu tidak terlihat: `load()` menangkapnya, lalu state
 * dianggap kosong - task yang sedang berjalan hilang tanpa pesan.
 *
 * Kejadian 1 November 2026: skrip perbaikan menulis ulang
 * `.state/workflow-state.json` lewat `Set-Content -Encoding UTF8`, sehingga
 * berkas itu berawal BOM. Selama beberapa menit, state yang sedang dipakai sesi
 * lain tidak bisa dibaca ulang, dan migrasi per proyek ikut batal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowState, resolveStateFile } from "../workflow-state.js";

const BOM = "\uFEFF";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-bom-"));
}

function tulisState(berkas, isi) {
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  fs.writeFileSync(berkas, BOM + JSON.stringify(isi, null, 2), "utf8");
}

test("berkas state berawalan BOM tetap terbaca, task tidak hilang", async () => {
  const berkas = path.join(tmp(), "workflow-state.json");
  tulisState(berkas, {
    currentPhase: "commit",
    taskDescription: "task yang ditulis lewat PowerShell",
    projectDir: "D:\\code\\contoh",
    definitionOfDone: [{ id: "dod-1", text: "sesuatu", status: "open" }],
  });

  const ws = new WorkflowState(berkas);
  await ws.load();

  assert.equal(ws.state.taskDescription, "task yang ditulis lewat PowerShell");
  assert.equal(ws.state.currentPhase, "commit");
  assert.equal(ws.state.projectDir, "D:\\code\\contoh");
});

test("migrasi per proyek tidak batal hanya karena BOM", () => {
  const root = tmp();
  const proyek = path.join(root, "clinic");
  fs.mkdirSync(path.join(proyek, ".git"), { recursive: true });
  const base = path.join(root, "state");
  const lama = path.join(base, "workflow-state.json");
  // State menganggur dengan sengaja: sejak 1.17.0 state bertask aktif memang
  // TIDAK dimigrasikan, dan yang diuji di sini adalah toleransi BOM pada
  // pembacaannya, bukan aturan migrasi itu.
  tulisState(lama, {
    currentPhase: "idle",
    taskDescription: "",
    projectDir: proyek,
    marker: "task lama ber-BOM",
  });

  const cwdLama = process.cwd();
  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const initLama = process.env.INIT_CWD;
  let baru;
  try {
    process.env.DEV_WORKFLOW_STATE_FILE = lama;
    delete process.env.INIT_CWD;
    process.chdir(proyek);
    baru = resolveStateFile();
  } finally {
    process.chdir(cwdLama);
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    if (initLama === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initLama;
  }

  assert.ok(fs.existsSync(baru), "state proyek harus dibuat dari berkas ber-BOM");
  const isi = JSON.parse(fs.readFileSync(baru, "utf8"));
  assert.equal(isi.marker, "task lama ber-BOM");
});