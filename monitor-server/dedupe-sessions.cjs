'use strict';

/**
 * Gabungkan sesi yang duplikat sebelum ditampilkan.
 *
 * MASALAH NYATA
 * -------------
 * Sebuah proses MCP bisa berjalan TANPA menerima ID sesi OpenCode, dan pelapor
 * lalu memakai PID proses sebagai kunci sesi (`pid-99880`). Ketika sesi
 * OpenCode yang sama juga melapor dengan kunci `ses_...`, keduanya tampil di
 * tablet sebagai kartu berbeda dengan task identik - diukur 2 November 2026:
 * dua kartu "Perbaiki tampilan kartu di Mac" berdampingan, satu punya judul
 * dan satu tidak.
 *
 * MENGAPA TIDAK MEMPERBAIKI KUNCI SAJA
 * ------------------------------------
 * Mengubah cara kunci dibuat berarti setiap sesi lama dan baru tidak lagi
 * cocok, sehingga justru MENAMBAH baris. Karena itu identitas di database
 * dibiarkan apa adanya; penggabungan dilakukan saat membaca, dan hanya untuk
 * kartu yang benar-benar kembar.
 *
 * ATURAN
 * ------
 * 1. Kembar = mesin sama DAN task sama DAN task tidak kosong.
 * 2. Di antara kembar, kunci `ses_` menang atas `pid-`, karena hanya `ses_`
 *    yang bisa dicari judulnya.
 * 3. Sesi dengan task kosong TIDAK PERNAH digabung - dua mesin menganggur
 *    bukan duplikat.
 */

/** Apakah kunci ini berasal dari ID sesi OpenCode (bukan PID). */
function isSessionKey(key) {
  return /^ses[_-]/i.test(String(key || ''));
}

/**
 * Susun daftar tampilan: duplikat dibuang, sisanya dipertahankan urutan asal.
 *
 * @param {Array<object>} sessions baris dari database (sudah berurutan)
 * @returns {Array<object>}
 */
function dedupeSessions(sessions) {
  const daftar = Array.isArray(sessions) ? sessions : [];
  const kunci = (s) =>
    [String(s.machine || ''), String(s.task || '').trim()].join('\u0000');

  // Kelompokkan hanya sesi yang punya task.
  const pemenang = new Map();
  for (const s of daftar) {
    const task = String(s.task || '').trim();
    if (!task) continue;
    const k = kunci(s);
    const sekarang = pemenang.get(k);
    if (!sekarang) {
      pemenang.set(k, s);
      continue;
    }
    // Ganti hanya bila yang tersimpan bukan `ses_` dan yang baru `ses_`.
    if (!isSessionKey(sekarang.session_key) && isSessionKey(s.session_key)) {
      pemenang.set(k, s);
    }
  }

  const dibuang = new Set();
  for (const s of daftar) {
    const task = String(s.task || '').trim();
    if (!task) continue;
    const menang = pemenang.get(kunci(s));
    if (menang && menang.session_key !== s.session_key) {
      dibuang.add(s.session_key);
    }
  }

  return daftar.filter((s) => !dibuang.has(s.session_key));
}

module.exports = { dedupeSessions, isSessionKey };
