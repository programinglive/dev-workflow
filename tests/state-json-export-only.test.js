import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { WorkflowState } from "../workflow-state.js";

/**
 * Berkas JSON kini EKSPOR, bukan kebenaran.
 *
 * Alat lama masih membacanya, jadi ia tetap ditulis. Tetapi apa pun yang
 * dilakukan orang pada berkas itu - mengubahnya, menghapusnya, atau menulisnya
 * di disk penuh - tidak boleh mengubah state yang dipakai agen, dan tidak boleh
 * menggagalkan penyimpanan yang sebenarnya berhasil.
 */
async function withState(fn, { stateDirOverride = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-export-"));
  const stateDir = stateDirOverride || path.join(dir, ".state");
  const stateFile = path.join(stateDir, "workflow-state.json");
  const adapter = new SqliteAdapter({ dbPath: path.join(dir, "state.db") });

  const ws = new WorkflowState(stateFile, { db: adapter, sessionId: "ses_export" });
  await ws.load();

  try {
    await fn({ ws, adapter, stateFile });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("berkas JSON tetap ditulis sebagai ekspor", async () => {
  await withState(async ({ ws, stateFile }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "ekspor";
    await ws.save();

    const onDisk = JSON.parse(await readFile(stateFile, "utf-8"));
    assert.equal(onDisk.taskDescription, "ekspor");
  });
});

test("berkas JSON diubah tangan tidak mengubah state sesi", async () => {
  await withState(async ({ ws, stateFile }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "asli";
    await ws.save();

    await writeFile(stateFile, JSON.stringify({ taskDescription: "diubah tangan" }));

    const reloaded = new WorkflowState(stateFile, { db: ws.dbAdapter, sessionId: "ses_export" });
    await reloaded.load();
    assert.equal(reloaded.state.taskDescription, "asli", "SQLite yang menang");
  });
});

test("berkas JSON dihapus tidak menghilangkan state", async () => {
  await withState(async ({ ws, stateFile }) => {
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "tetap ada";
    await ws.save();

    await rm(stateFile, { force: true });

    const reloaded = new WorkflowState(stateFile, { db: ws.dbAdapter, sessionId: "ses_export" });
    await reloaded.load();
    assert.equal(reloaded.state.taskDescription, "tetap ada");
  });
});

test("gagal menulis ekspor tidak menggagalkan save", async () => {
  await withState(async ({ ws }) => {
    // Direktori yang tidak bisa dibuat di Windows: huruf drive tidak ada.
    ws.stateFile = "Z:\\tidak\\ada\\state.json";
    ws.state.currentPhase = "coding";
    ws.state.taskDescription = "tetap tersimpan";

    const r = await ws.save();
    assert.equal(r.verified, true, "kegagalan ekspor tidak boleh membatalkan penyimpanan");

    const reloaded = new WorkflowState(ws.stateFile, { db: ws.dbAdapter, sessionId: "ses_export" });
    await reloaded.load();
    assert.equal(reloaded.state.taskDescription, "tetap tersimpan");
  });
});

test("save() tidak lagi membaca berkas untuk memutuskan konflik", async () => {
  const { readFile: readSource } = await import("node:fs/promises");
  const source = await readSource(new URL("../workflow-state.js", import.meta.url), "utf-8");

  const saveBody = source.slice(
    source.indexOf("async save(options = {})"),
    source.indexOf("async verifyPersisted("),
  );

  assert.ok(saveBody.length > 0, "save() harus ditemukan");
  assert.equal(
    saveBody.includes("reconcileWithDisk("),
    false,
    "save() tidak boleh merekonsiliasi berkas lagi",
  );
  assert.equal(
    saveBody.includes("adoptDiskState("),
    false,
    "save() tidak boleh mengadopsi state berkas",
  );
});