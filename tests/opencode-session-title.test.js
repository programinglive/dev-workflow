import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Pemilik bertanya: "emang kamu ngga bisa dapat judul session opencodenya?"
 *
 * Bisa. OpenCode menyimpan judul percakapan di tabel `session_v2` (kolom
 * `title`) pada opencode.db, dan `id` di sana SAMA PERSIS dengan `session_key`
 * yang sudah dikirim pelapor. Bukti saat diperiksa: ses_e6a3253...
 * berjudul "MCP workflow: README dan saran lanjutan".
 *
 * Yang dijaga di sini: pembacaan judul TIDAK BOLEH pernah menggagalkan
 * pelaporan, karena ini hanya hiasan.
 */

const { sessionTitle, updateSessionTitle, resetTitleCache, candidatePaths } = require(
  "../opencode-session-title.cjs",
);

test("tanpa database: mengembalikan string kosong, bukan melempar", () => {
  resetTitleCache();
  const dir = mkdtempSync(path.join(tmpdir(), "dwf-title-"));
  try {
    const hasil = sessionTitle("ses_tidak_ada", { env: { OPENCODE_DB: path.join(dir, "x.db") } });
    assert.equal(hasil, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kunci sesi kosong tidak membaca apa pun", () => {
  resetTitleCache();
  assert.equal(sessionTitle(""), "");
  assert.equal(sessionTitle(null), "");
});

test("updateSessionTitle menolak kunci atau judul kosong dengan anggun", () => {
  resetTitleCache();
  assert.equal(updateSessionTitle("", "Judul Baru"), false);
  assert.equal(updateSessionTitle("ses_1", ""), false);
  assert.equal(updateSessionTitle(null, null), false);
});

test("updateSessionTitle memperbarui database SQLite session_v2 dan cache", () => {
  resetTitleCache();
  const Database = require("better-sqlite3");
  const dir = mkdtempSync(path.join(tmpdir(), "dwf-title-db-"));
  const dbPath = path.join(dir, "opencode.db");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        title TEXT,
        time_updated INTEGER
      );
      INSERT INTO session_v2 (id, title, time_updated) VALUES ('ses_test_1', 'Old Prompt Title', 1000);
    `);
    db.close();

    const env = { OPENCODE_DB: dbPath };

    // Baca judul awal
    assert.equal(sessionTitle("ses_test_1", { env }), "Old Prompt Title");

    // Update judul sesi ke tugas baru
    const ok = updateSessionTitle("ses_test_1", "New Synchronized Task Description", { env });
    assert.equal(ok, true);

    // Cache dan pembacaan ulang langsung mengembalikan judul baru
    assert.equal(sessionTitle("ses_test_1", { env }), "New Synchronized Task Description");

    // Periksa bahwa data fisik di SQLite benar-benar berubah
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT title, time_updated FROM session_v2 WHERE id = ?").get("ses_test_1");
      assert.equal(row.title, "New Synchronized Task Description");
      assert.ok(row.time_updated > 1000);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleStartTask otomatis memperbarui session_v2.title saat task baru dimulai", async () => {
  resetTitleCache();
  const Database = require("better-sqlite3");
  const dir = mkdtempSync(path.join(tmpdir(), "dwf-title-start-"));
  const dbPath = path.join(dir, "opencode.db");

  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        title TEXT,
        time_updated INTEGER
      );
      INSERT INTO session_v2 (id, title, time_updated) VALUES ('ses_active_1', 'Stale 5-day-old prompt', 1000);
    `);
    db.close();

    const oldEnv = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = dbPath;

    try {
      const { WorkflowState } = await import("../workflow-state.js");
      const { handleStartTask } = await import("../tools/handler-modules/workflow-handlers.js");

      const statePath = path.join(dir, "workflow-state.json");
      const ws = new WorkflowState(statePath);
      ws.sessionId = "ses_active_1";

      try {
        const res = await handleStartTask(
          {
            description: "Implement continuous speech overlay on Xiaomi Pad 6",
            type: "feature",
            definitionOfDone: ["overlay runs smoothly"],
            plan: ["code", "verify"],
          },
          ws,
          null,
        );

        assert.match(res.content[0].text, /Task Started/);

        // Pastikan sessionTitle sudah sinkron dengan deskripsi task baru
        assert.equal(sessionTitle("ses_active_1"), "Implement continuous speech overlay on Xiaomi Pad 6");

        // Pastikan di database SQLite opencode.db judulnya sudah benar-benar terupdate
        const verifyDb = new Database(dbPath, { readonly: true });
        try {
          const row = verifyDb.prepare("SELECT title, time_updated FROM session_v2 WHERE id = ?").get("ses_active_1");
          assert.equal(row.title, "Implement continuous speech overlay on Xiaomi Pad 6");
          assert.ok(row.time_updated > 1000);
        } finally {
          verifyDb.close();
        }
      } finally {
        if (ws?.dbAdapter && typeof ws.dbAdapter.close === "function") await ws.dbAdapter.close();
        else if (ws?.dbAdapter?.db && typeof ws.dbAdapter.db.close === "function") ws.dbAdapter.db.close();
      }
    } finally {
      if (oldEnv === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = oldEnv;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lokasi database mencakup env, XDG, dan home", () => {
  const jalur = candidatePaths({
    OPENCODE_DB: "/kustom/opencode.db",
    XDG_DATA_HOME: "/xdg",
    USERPROFILE: "/home/uji",
  });
  assert.ok(jalur.includes("/kustom/opencode.db"));
  assert.ok(jalur.includes(path.join("/xdg", "opencode", "opencode.db")));
  assert.ok(jalur.some((p) => p.includes("opencode.db")));
});
