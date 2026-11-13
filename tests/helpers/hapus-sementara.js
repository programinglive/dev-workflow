/**
 * Membersihkan direktori sementara pada tes yang menyentuh SQLite.
 *
 * MENGAPA BERKAS INI ADA
 * ----------------------
 * `npm run test:security` berulang kali GAGAL di mesin pengembang Windows
 * (3 November 2026) dengan:
 *
 *   EBUSY: resource busy or locked, unlink '...\dev-workflow.db-shm'
 *
 * Padahal CI hijau dan tidak ada satu pun fitur yang rusak. Sebabnya: berkas
 * SQLite yang baru ditutup masih dipegang proses sekejap, dan
 * `fs.rm(dir, { recursive: true, force: true })` TIDAK menolong - `force`
 * hanya mengabaikan ENOENT, bukan EBUSY.
 *
 * Ini bukan sekadar merepotkan. Tes yang merah palsu akan diabaikan orang, dan
 * kegagalan keamanan yang sungguhan tenggelam di dalamnya. Pola coba-ulang
 * yang sama sudah dipakai `tests/setup-env.js` untuk masalah identik.
 *
 * Yang diulang HANYA galat "berkas masih dipegang". EACCES, ENOENT, dan galat
 * lain tetap dilempar pada percobaan pertama - menelan semuanya berarti tes
 * lolos karena pembersihannya gagal, bukan karena perilakunya benar.
 */

import fs from 'node:fs/promises';

/** Jeda antarpercobaan; total di bawah 1 detik. */
const JEDA_MS = [0, 25, 50, 100, 200, 400];

/** Galat yang berarti "coba lagi nanti", bukan "berhenti". */
const BOLEH_ULANG = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/**
 * @param {string} dir direktori sementara
 * @param {object} [opsi]
 * @param {function} [opsi.rmImpl] disuntikkan untuk pengujian
 * @returns {Promise<void>}
 */
export async function hapusSementara(dir, { rmImpl } = {}) {
  const hapus = rmImpl || ((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 0 }));

  let terakhir = null;
  for (let i = 0; i < JEDA_MS.length; i += 1) {
    try {
      await hapus(dir);
      return;
    } catch (e) {
      terakhir = e;
      const kode = e && e.code;
      if (!BOLEH_ULANG.has(kode) || i === JEDA_MS.length - 1) throw e;
      await new Promise((r) => setTimeout(r, JEDA_MS[i]));
    }
  }
  throw terakhir;
}

export const JEDA_ULANG_MS = JEDA_MS;
