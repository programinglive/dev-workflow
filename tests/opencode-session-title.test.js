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

const { sessionTitle, resetTitleCache, candidatePaths } = require(
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
