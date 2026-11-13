import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ATURAN PEMILIK DATA: tidak ada baris production yang boleh terhapus tanpa
 * persetujuan eksplisit.
 *
 * Penghapusan otomatis yang menyala sendiri adalah cara paling mudah
 * kehilangan riwayat tanpa ada yang menyadarinya. Karena itu bawaannya MATI,
 * dan berkas ini menguji bawaannya - bukan hanya jalur "aktif"-nya.
 *
 * Yang diuji adalah perilaku berkas dashboard.cjs yang sebenarnya: dengan
 * PRUNE_ENABLED kosong, server TIDAK boleh menjalankan satu pun DELETE.
 */
function bootLog(env) {
  // Server dijalankan dengan DATABASE_URL kosong dan port acak; yang dibaca
  // hanya baris log saat start, lalu proses dihentikan.
  const script = `
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    process.env.DATABASE_URL = "";
    require(${JSON.stringify(path.join(ROOT, "monitor-server", "dashboard.cjs"))});
    setTimeout(() => process.exit(0), 1200);
  `;
  return execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

test("bawaan: retensi MATI dan tidak ada yang dihapus", () => {
  const out = bootLog({ PRUNE_ENABLED: "" });
  assert.match(out, /retensi: MATI/);
  // Tidak boleh ada satu pun janji penghapusan di log bawaan.
  assert.ok(!/retensi: AKTIF/.test(out), "bawaan tidak boleh mengaktifkan retensi");
});

test("PRUNE_ENABLED=1 barulah menyalakan retensi", () => {
  const out = bootLog({ PRUNE_ENABLED: "1" });
  assert.match(out, /retensi: AKTIF/);
});

test("nilai lain selain 1/true/yes tetap dianggap mati", () => {
  for (const value of ["0", "false", "no", "mati", "n"]) {
    const out = bootLog({ PRUNE_ENABLED: value });
    assert.match(out, /retensi: MATI/, `PRUNE_ENABLED=${value} seharusnya mati`);
  }
});
