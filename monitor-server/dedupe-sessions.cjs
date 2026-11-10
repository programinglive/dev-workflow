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
 * 4. Baris IDENTITAS sesi (task kosong) DIGABUNG ke baris kartunya di sesi yang
 *    sama, dan yang dipertahankan adalah baris kartu yang lebih kaya.
 *
 * MENGAPA ATURAN 4 ADA (diukur 10 November 2026)
 * ----------------------------------------------
 * Tabel `sessions` berkunci `(session_key, task_id)`, jadi satu sesi memiliki
 * baris identitas (`task_id = ''`) DAN satu baris per task. Baris identitas
 * tidak membawa relasi, sehingga dashboard menggambar kartu kedua untuk sesi
 * yang sama dengan tulisan "Flow belum ada" - pemilik membacanya sebagai "AI
 * berhenti merencanakan", padahal kartu di sebelahnya menampilkan Draw #126
 * dengan benar. Aturan 3 tetap berlaku untuk sesi tanpa kembaran: sesi idle
 * yang berdiri sendiri memang kartu yang sah.
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

  const kept = daftar.filter((s) => !dibuang.has(s.session_key));

  // Rule 4: the session IDENTITY row is the one the upsert writes with an empty
  // `task_id` AND an empty `task`. It is a placeholder for the same session, so
  // it is dropped when that session also has a card row here.
  //
  // WHY `task_id` AND NOT JUST `task`
  // ---------------------------------
  // Measured against production on 10 November 2026: a finished task keeps its
  // `task_id` while its `task` is cleared (that is the documented way to close a
  // task), and that row still carries its Zettly, Factory and Draw relations.
  // Dropping every row with an empty `task` would have erased those relations
  // whenever a sibling card existed. Only a row with BOTH fields empty is the
  // identity row.
  const hasCardRow = new Set(
    kept
      .filter((s) => String(s.task_id || '').trim() !== '')
      .map((s) => String(s.session_key || ''))
  );

  return kept.filter((s) => {
    const identityRow =
      String(s.task_id || '').trim() === '' && String(s.task || '').trim() === '';
    if (!identityRow) return true;
    return !hasCardRow.has(String(s.session_key || ''));
  });
}

module.exports = { dedupeSessions, isSessionKey };
