'use strict';

/**
 * Aturan pembersihan data dan pemeriksaan token tulis.
 *
 * Dipisah dari dashboard.cjs supaya bisa diuji tanpa Postgres dan tanpa
 * menjalankan server: berkas ini hanya menyusun SQL dan membandingkan string.
 *
 * MENGAPA PEMBERSIHAN ADA
 * -----------------------
 * Tanpa ini `events` tumbuh selamanya. Barisnya kecil, jadi tidak ada yang
 * menyadarinya sampai berbulan-bulan kemudian, ketika `/api/sessions` mulai
 * lambat dan tidak jelas sebabnya. Diukur 1 November 2026: belum ada satu pun
 * `DELETE` di server.
 *
 * MENGAPA TOKEN HANYA UNTUK TULIS
 * -------------------------------
 * Dashboard memang harus terbuka tanpa login - itu tujuannya. Tetapi MENULIS
 * berbeda: siapa pun yang bisa menjangkau port 3100 di tailnet dapat mengirim
 * `POST /api/session` dan memunculkan sesi palsu di layar tablet. Membaca tetap
 * bebas; hanya menulis yang perlu bukti.
 */

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_SESSION_RETENTION_DAYS = 7;

/** Buang event lama. Dijalankan berkala, bukan di jalur permintaan. */
function buildPruneEventsQuery({ retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  return {
    sql: `DELETE FROM events WHERE at < now() - ($1::text || ' days')::interval`,
    params: [String(retentionDays || DEFAULT_RETENTION_DAYS)],
  };
}

/**
 * Buang sesi `idle` yang sudah lama.
 *
 * Hanya `idle`: sesi yang masih bekerja tidak boleh dihapus, seberapa lama pun
 * ia berjalan, karena baris itulah yang sedang ditampilkan di tablet.
 */
function buildPruneSessionsQuery({ sessionRetentionDays = DEFAULT_SESSION_RETENTION_DAYS } = {}) {
  return {
    sql: `DELETE FROM sessions WHERE phase = 'idle' AND updated_at < now() - ($1::text || ' days')::interval`,
    params: [String(sessionRetentionDays || DEFAULT_SESSION_RETENTION_DAYS)],
  };
}

/**
 * Apakah permintaan tulis boleh diterima.
 *
 * Tanpa token yang dikonfigurasi, penulisan DITOLAK. Itu pilihan sadar: monitor
 * yang lupa dikonfigurasi lebih baik berhenti menerima laporan daripada diam-
 * diam menerima laporan dari siapa saja. Bandingkan dengan nilai kosong supaya
 * `Authorization: Bearer ` (token kosong) tidak lolos.
 */
function isWriteAuthorized({ header, expectedToken }) {
  const expected = String(expectedToken || '').trim();
  if (!expected) return false;
  const raw = String(header || '');
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) return false;
  const given = match[1].trim();
  if (given.length !== expected.length) return false;
  // Perbandingan waktu-tetap sederhana: panjang sudah disamakan di atas, dan
  // perbedaan dikumpulkan sehingga tidak keluar lebih awal pada byte pertama
  // yang berbeda.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

module.exports = {
  buildPruneEventsQuery,
  buildPruneSessionsQuery,
  isWriteAuthorized,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
};
