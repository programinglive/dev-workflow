'use strict';

/**
 * Peringatan yang bisa dibaca manusia: "monitor yang memberi tahu, bukan yang
 * ditunggu".
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Sampai 2 November 2026 tablet hanya berguna kalau pemilik ingat melihatnya.
 * Sesi yang macet dan mesin yang berhenti melapor tidak pernah memberi tahu
 * siapa pun - monitor jadi hiasan.
 *
 * ATURAN YANG TIDAK BOLEH DILANGGAR
 * ---------------------------------
 * 1. Tidak mengklaim lebih dari yang bisa dibuktikan. Dari server, sesi yang
 *    diam TIDAK bisa dibedakan antara "macet" dan "task sudah ditutup lalu
 *    ditinggal". Karena itu labelnya "mungkin macet", dan mesin yang diam
 *    disebut "tidak melapor" - BUKAN "mati". Dua kali saya mengulangi
 *    kesalahan itu (ambang 30 menit, label online/offline) dan keduanya
 *    berbohong ke arah yang sama.
 *
 * 2. Ambangnya harus cukup longgar sehingga peringatan tetap berarti. Sesi
 *    yang baru berhenti 5 menit bukan macet; mesin yang menganggur dua jam
 *    bukan mati. Peringatan yang terlalu sering akan diabaikan, dan itu sama
 *    saja dengan tidak punya peringatan.
 *
 * 3. Sesi `idle` tidak pernah diperingatkan. `idle` berarti task DITUTUP -
 *    diam adalah hasil yang benar, bukan masalah.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, jadi bisa diuji
 * langsung.
 */

/** Sesi "mungkin macet" baru diperingatkan setelah diam selama ini. */
const DEFAULT_STUCK_ALERT_MS = 30 * 60 * 1000;
/** Mesin baru diperingatkan setelah diam selama ini. */
const DEFAULT_MACHINE_SILENT_MS = 24 * 60 * 60 * 1000;

const MENIT = 60 * 1000;
const JAM = 60 * MENIT;
const HARI = 24 * JAM;

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** "45 menit", "3 jam", "2 hari" - dibulatkan ke satuan yang terbaca. */
function jarak(ms) {
  const detik = Math.max(0, Math.floor(ms / 1000));
  if (detik < 60) return `${detik} detik`;
  if (detik < JAM / 1000) return `${Math.floor(detik / 60)} menit`;
  if (detik < HARI / 1000) return `${Math.floor(detik / 3600)} jam`;
  return `${Math.floor(detik / 86400)} hari`;
}

/**
 * Nama yang bisa dibaca untuk sebuah sesi.
 *
 * Sesi lama bisa kosong di ketiga kolom (`task`, `session_title`,
 * `project_name`). Dua baris kosong tidak bisa dibedakan satu sama lain, jadi
 * potongan `session_key` dipakai sebagai penanda terakhir.
 */
function judulSesi(s) {
  const teks = [s.task, s.session_title, s.project_name]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v.length > 0);
  if (teks) return teks;
  const key = String(s.session_key || '').trim();
  if (!key) return 'sesi tanpa nama';
  return key.length > 12 ? key.slice(0, 12) : key;
}

/**
 * Potong judul panjang supaya pesannya tetap terbaca.
 *
 * Terbukti di data nyata: judul task 90 karakter disambung menjadi
 * "... tidak melapor 18 menit - mungkin macet", dan tidak ada yang membacanya.
 */
function pendek(teks, maks = 38) {
  const t = String(teks || '').trim();
  if (t.length <= maks) return t;
  return t.slice(0, maks - 1).trimEnd() + '…';
}

/**
 * @param {object} args
 * @param {Array} [args.sessions]  baris sesi, sudah berisi `state` turunan
 * @param {Array} [args.machines]  baris mesin, berisi `last_seen`
 * @param {Date|string|number} [args.now]
 * @param {number} [args.stuckAlertMs]
 * @param {number} [args.machineSilentMs]
 * @returns {Array<{kind: string, pesan: string, umur_ms: number}>}
 */
function buildAlerts({
  sessions,
  machines,
  now = Date.now(),
  stuckAlertMs = DEFAULT_STUCK_ALERT_MS,
  machineSilentMs = DEFAULT_MACHINE_SILENT_MS,
} = {}) {
  const sekarang = toMs(now);
  if (sekarang === null) return [];

  const batasMacet = Number(stuckAlertMs) > 0 ? Number(stuckAlertMs) : DEFAULT_STUCK_ALERT_MS;
  const batasDiam = Number(machineSilentMs) > 0 ? Number(machineSilentMs) : DEFAULT_MACHINE_SILENT_MS;
  const hasil = [];

  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object') continue;
    // Hanya sesi yang statusnya "mungkin macet" yang bisa diperingatkan.
    // `idle` adalah hasil yang benar; `ended` adalah sesi yang memang sudah
    // lama tidak dilaporkan dan akan membanjiri layar kalau ikut dihitung.
    if (s.state !== 'possibly_stuck') continue;
    // `sekarang - null` menghasilkan angka (null menjadi 0), jadi waktu yang
    // tidak sah harus diperiksa SEBELUM dikurangi - kalau tidak, setiap baris
    // rusak akan tampak berumur setengah abad dan langsung memicu peringatan.
    const terakhir = toMs(s.updated_at);
    if (terakhir === null) continue;
    const umur = sekarang - terakhir;
    if (!Number.isFinite(umur) || umur <= batasMacet) continue;
    const judul = judulSesi(s);
    hasil.push({
      kind: 'sesi_macet',
      session_key: s.session_key,
      machine: s.machine || '',
      judul,
      umur_ms: umur,
      pesan: `${pendek(judul)} tidak melapor ${jarak(umur)} - mungkin macet`,
    });
  }

  for (const m of Array.isArray(machines) ? machines : []) {
    if (!m || typeof m !== 'object') continue;
    const terakhir = toMs(m.last_seen);
    if (terakhir === null) continue;
    const umur = sekarang - terakhir;
    if (!Number.isFinite(umur) || umur <= batasDiam) continue;
    const nama = String(m.machine || '').trim() || 'mesin tanpa nama';
    hasil.push({
      kind: 'mesin_diam',
      machine: nama,
      umur_ms: umur,
      pesan: `${nama} tidak melapor ${jarak(umur)}`,
    });
  }

  // Yang paling lama didahulukan: itu yang paling perlu dilihat.
  return hasil.sort((a, b) => b.umur_ms - a.umur_ms);
}

module.exports = {
  buildAlerts,
  judulSesi,
  jarak,
  DEFAULT_STUCK_ALERT_MS,
  DEFAULT_MACHINE_SILENT_MS,
};
