'use strict';

/**
 * Penanda "data masih hidup".
 *
 * MASALAH YANG DITUTUP
 * --------------------
 * Tanpa ini, dashboard yang mati dan dashboard yang memang tidak ada
 * pekerjaan tampak IDENTIK: kartu yang sama, angka yang sama. Diukur
 * 1 November 2026 dengan menghentikan service: layar tablet tidak berubah
 * sama sekali. Diam bisa berarti dua hal yang sangat berbeda, dan pemiliknya
 * tidak punya cara membedakannya.
 *
 * Yang dihitung di sini bukan "apakah ada pekerjaan", melainkan "kapan
 * terakhir kali server menerima laporan apa pun". Kalau angka itu sudah tua,
 * yang rusak adalah jalur pelaporannya - bukan berarti semua orang berhenti
 * bekerja.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, sehingga bisa diuji
 * langsung.
 */

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Ubah `now` dan `lastReportAt` menjadi status kesehatan.
 *
 * @param {object} args
 * @param {Date|string|number|null} args.lastReportAt
 * @param {Date|string|number} [args.now]
 * @param {number} [args.staleAfterMs]
 * @returns {{ lastReportAt: string|null, ageMs: number|null, stale: boolean, never: boolean }}
 */
function buildHealth({ lastReportAt, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const nowMs = toMs(now);
  const lastMs = toMs(lastReportAt);

  if (lastMs === null) {
    // Belum pernah ada laporan sama sekali: itu juga "basi", dan dibedakan
    // supaya pesannya bisa lebih tepat ("belum pernah" vs "sudah lama").
    return { lastReportAt: null, ageMs: null, stale: true, never: true };
  }

  const ageMs = Math.max(0, nowMs - lastMs);
  return {
    lastReportAt: new Date(lastMs).toISOString(),
    ageMs,
    stale: ageMs > staleAfterMs,
    never: false,
  };
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { buildHealth, toMs, DEFAULT_STALE_AFTER_MS };
