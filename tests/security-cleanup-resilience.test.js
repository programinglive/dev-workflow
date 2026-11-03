import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Kegagalan nyata yang berulang di mesin pengembang (Windows) 3 November 2026
 *
 * `npm run test:security` GAGAL dengan:
 *
 *   EBUSY: resource busy or locked, unlink '...\dev-workflow.db-shm'
 *
 * Padahal CI hijau. Sebabnya bukan fitur yang diuji, melainkan cara tes
 * membersihkan: `fs.rm(dir, { recursive: true, force: true })` mencoba
 * MENGHAPUS begitu saja. Di Windows, berkas SQLite yang baru ditutup masih
 * dipegang proses sekejap, dan `force` tidak menolong - ia hanya mengabaikan
 * ENOENT, bukan EBUSY.
 *
 * Akibatnya berbahaya: tes yang gagal karena pembersihan tampak seperti tes
 * keamanan yang gagal. Suite yang merah palsu akan diabaikan orang, dan
 * kegagalan yang sungguhan tenggelam di dalamnya.
 *
 * Perbaikannya: coba ulang dengan jeda pendek - pola yang sudah dipakai
 * `tests/setup-env.js` untuk masalah yang sama.
 */

const JEDA_MS = [0, 25, 50, 100, 200, 400];

/**
 * Hapus direktori sementara dengan percobaan ulang.
 *
 * `force: false` supaya ENOENT tetap jadi galat yang terlihat; yang diulang
 * hanya EBUSY/EPERM/ENOTEMPTY - galat "berkas masih dipegang", bukan
 * "berkas tidak ada".
 */
async function hapusDenganSabar(dir) {
  for (let i = 0; i < JEDA_MS.length; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (e) {
      const kode = e && e.code;
      const bolehUlang = kode === "EBUSY" || kode === "EPERM" || kode === "ENOTEMPTY";
      if (!bolehUlang || i === JEDA_MS.length - 1) throw e;
      await new Promise((r) => setTimeout(r, JEDA_MS[i]));
    }
  }
}

test("pembersihan mengulang saat berkas masih dipegang (EBUSY), bukan menyerah", async () => {
  const { hapusSementara, JEDA_ULANG_MS } = await import("./helpers/hapus-sementara.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hapus-uji-"));
  await writeFile(path.join(dir, "dev-workflow.db-shm"), "x");

  let percobaan = 0;
  const rmPalsu = async () => {
    percobaan += 1;
    // Dua percobaan pertama meniru Windows yang belum melepas handle.
    if (percobaan < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    await rm(dir, { recursive: true, force: true });
  };

  await hapusSementara(dir, { rmImpl: rmPalsu });
  assert.equal(percobaan, 3, "harus mencoba lagi sampai berhasil");
  assert.ok(JEDA_ULANG_MS.length >= 3, "harus ada beberapa percobaan, bukan satu");
});

/**
 * Yang dijaga di sini adalah SEBAB kegagalan yang pernah terjadi, bukan hanya
 * gejalanya. Mencoba ulang tidak menolong bila koneksi SQLite masih terbuka:
 * handle-nya dipegang proses ini sendiri, seberapa lama pun menunggu.
 *
 * Terbukti 3 November 2026: menghapus penutupan adapter dari `temporary()`
 * membuat 6 tes gagal lagi dengan EBUSY yang sama.
 */
test("koneksi SQLite ditutup sebelum direktori sementara dihapus", async () => {
  const sumber = await readFile(new URL("./security-boundaries.test.js", import.meta.url), "utf8");
  assert.match(sumber, /dbAdapter\.close|dbAdapter\.db\.close/, "adapter harus ditutup");
  assert.match(sumber, /daftar\(state\)/, "setiap WorkflowState didaftarkan untuk ditutup");
  // Tanpa percobaan ulang, satu jeda singkat Windows langsung menggagalkan tes.
  assert.match(sumber, /hapusSementara/);
});

test("galat yang BUKAN masalah kunci tidak ditelan", async () => {
  const { hapusSementara } = await import("./helpers/hapus-sementara.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hapus-uji-"));
  try {
    let percobaan = 0;
    const rmPalsu = async () => {
      percobaan += 1;
      throw Object.assign(new Error("akses ditolak"), { code: "EACCES" });
    };
    await assert.rejects(
      hapusSementara(dir, { rmImpl: rmPalsu }),
      /akses ditolak/,
      "EACCES bukan EBUSY: jangan diulang diam-diam",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pembersihan sungguhan berhasil pada direktori berisi berkas", async () => {
  const { hapusSementara } = await import("./helpers/hapus-sementara.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "hapus-uji-"));
  await mkdir(path.join(dir, ".state"), { recursive: true });
  await writeFile(path.join(dir, ".state", "dev-workflow.db"), "x");
  await writeFile(path.join(dir, ".state", "dev-workflow.db-shm"), "x");
  await hapusSementara(dir);
  await assert.rejects(readFile(path.join(dir, ".state", "dev-workflow.db")), { code: "ENOENT" });
});
