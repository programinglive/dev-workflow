'use strict';

/**
 * Klasifikasi status sesi.
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Diukur 1 November 2026: task yang SUDAH selesai (commit, rilis, deploy)
 * masih tampil sebagai kartu `CODING` 52 menit kemudian, karena penutupan
 * manual tidak selalu mengubah `phase` menjadi `idle`. Akibatnya dashboard
 * berbohong ke arah yang paling berbahaya: mengaku ada pekerjaan yang hidup
 * padahal tidak ada. Itu juga melawan peringatan "tidak ada laporan masuk".
 *
 * MENGAPA BUKAN PEMERIKSAAN PID
 * -----------------------------
 * Rencana awal adalah memeriksa `owner_pid` dari server. Itu TIDAK BISA
 * dilakukan: PID berlaku per mesin, dan server adalah mesin yang berbeda.
 * Dibuktikan 1 November 2026 - pid 11460 memang HIDUP di HELLOWORLD, tetapi
 * tidak ada di server (`kill -0` gagal). Kalau diperiksa dari server, SETIAP
 * sesi akan tampak "sudah berakhir" - bug yang lebih buruk daripada masalah
 * aslinya.
 *
 * Karena itu yang dipakai adalah UMUR LAPORAN, dan hasilnya tidak mengklaim
 * lebih dari yang bisa dibuktikan: sesi tua disebut "mungkin macet", bukan
 * "mati".
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, jadi bisa diuji
 * langsung.
 */

/** Masih dianggap bekerja aktif bila melapor dalam rentang ini. */
const DEFAULT_LIVE_MS = 15 * 60 * 1000;
/** Di atas ini, sesi dianggap berakhir tanpa penutupan. */
const DEFAULT_STUCK_MS = 2 * 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {string} args.phase            fase dari state workflow
 * @param {Date|string|number} args.updatedAt  kapan terakhir melapor
 * @param {Date|string|number} [args.now]
 * @param {number} [args.liveMs]
 * @param {number} [args.stuckMs]
 * @returns {{ status: 'idle'|'live'|'possibly_stuck'|'ended', ageMs: number }}
 */
function classifySession({
  phase,
  updatedAt,
  now = Date.now(),
  liveMs = DEFAULT_LIVE_MS,
  stuckMs = DEFAULT_STUCK_MS,
} = {}) {
  const fase = String(phase || 'idle');
  const ageMs = ageOf(updatedAt, now);

  if (fase === 'idle') return { status: 'idle', ageMs };
  // Kartu yang sudah diserahkan ke kartu berikutnya dalam sesi yang sama
  // bukan pekerjaan aktif: sesinya hidup, topiknya sudah pindah.
  if (fase === 'handed-off') return { status: 'ended', ageMs };
  // Tanpa waktu laporan yang sah, tidak ada dasar untuk menyebutnya hidup.
  if (ageMs === null) return { status: 'ended', ageMs: null };
  if (ageMs <= liveMs) return { status: 'live', ageMs };
  if (ageMs <= stuckMs) return { status: 'possibly_stuck', ageMs };
  return { status: 'ended', ageMs };
}

function ageOf(value, now) {
  const lastMs = toMs(value);
  if (lastMs === null) return null;
  return Math.max(0, toMs(now) - lastMs);
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Label yang ditampilkan ke manusia. */
const LABELS = {
  idle: 'idle',
  live: 'aktif',
  possibly_stuck: 'mungkin macet',
  ended: 'berakhir',
};

module.exports = {
  classifySession,
  ageOf,
  toMs,
  LABELS,
  DEFAULT_LIVE_MS,
  DEFAULT_STUCK_MS,
};
