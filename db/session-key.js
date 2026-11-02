/**
 * Identitas sesi dan proyek, dalam satu tempat.
 *
 * Sebelumnya `resolveSessionKey` dan `sanitizeSessionKey` tinggal di
 * `workflow-state.js`, sementara migrasi butuh fungsi yang sama persis untuk
 * membaca nama berkas lama. Dua salinan berarti dua kesempatan berbeda, dan
 * perbedaan sekecil apa pun membuat baris migrasi menjadi yatim: tidak pernah
 * dibaca sesi mana pun.
 *
 * Karena itu keduanya pindah ke sini, dan modul ini tidak mengimpor apa pun dari
 * bagian lain aplikasi.
 */

import { randomUUID } from "crypto";

/** Nama kunci metadata yang dikirim OpenCode v2 pada setiap panggilan. */
export const SESSION_META_KEY = "ai.opencode/sessionID";

/**
 * Kunci cadangan untuk proses yang tidak mengirim metadata.
 *
 * Dihitung SEKALI per proses. `pid-<pid>` tidak dipakai lagi: satu proses MCP
 * bisa melayani beberapa jendela, dan `pid` yang sama membuat dua jendela
 * kebetulan berbagi kunci - persis tabrakan yang ingin dihapus. Dengan UUID,
 * dua proses selalu berbeda; yang tidak bisa dipisahkan tanpa metadata adalah
 * dua jendela DI DALAM satu proses, dan itu dicatat jujur sebagai
 * `process-random` alih-alih disembunyikan.
 */
const PROCESS_SESSION_KEY = `proc-${randomUUID()}`;

/**
 * Membersihkan nilai menjadi kunci yang aman untuk nama berkas dan kolom DB.
 *
 * Perilakunya sengaja identik dengan versi lama di `workflow-state.js`, karena
 * nama berkas state lama memakai aturan ini. Berbeda sedikit saja, migrasi akan
 * menghasilkan kunci yang tidak pernah cocok.
 */
export function sanitizeSessionKey(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "session").slice(0, 64);
}

/**
 * Menentukan kunci sesi beserta ASALNYA.
 *
 * Asal ikut dikembalikan supaya bisa dicatat di `state_writer`. Tanpa itu,
 * "sesi ini memakai kunci tebakan" tidak bisa dibedakan dari "sesi ini memakai
 * kunci yang benar", dan peringatan pertikaian kehilangan konteks.
 */
export function resolveSessionKeyWithSource(env = process.env, explicitSessionId = null, metaKey = null) {
  const fromRequest = typeof explicitSessionId === "string" ? explicitSessionId.trim() : "";
  if (fromRequest) {
    return { key: sanitizeSessionKey(fromRequest), source: "request-metadata" };
  }

  // `metaKey` disediakan untuk pemanggil yang membaca metadata sendiri lalu
  // ingin tetap tercatat sebagai metadata, bukan env.
  const fromMeta = typeof metaKey === "string" ? metaKey.trim() : "";
  if (fromMeta) {
    return { key: sanitizeSessionKey(fromMeta), source: "request-metadata" };
  }

  for (const candidate of [
    env?.DEV_WORKFLOW_SESSION_ID,
    env?.OPENCODE_SESSION_ID,
    env?.CLIENT_SESSION_ID,
  ]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return { key: sanitizeSessionKey(value), source: "env" };
  }

  return { key: PROCESS_SESSION_KEY, source: "process-random" };
}

/**
 * Menormalkan path proyek menjadi bentuk yang selalu sama.
 *
 * `D:\code\Foo`, `d:/code/foo`, dan `D:\code\Foo\` adalah proyek yang SAMA.
 * Tanpa normalisasi, ketiganya menjadi tiga baris berbeda dan riwayat sebuah
 * proyek terpecah hanya karena penulisan path berbeda antar pemanggil atau
 * antar sistem operasi.
 *
 * Huruf drive dikecilkan; Windows sendiri tidak membedakan besar-kecil huruf
 * pada path, jadi mengecilkannya tidak menghilangkan informasi.
 */
export function normalizeProjectPath(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text === "") return "";
  const slashed = text.replace(/\\/g, "/").replace(/\/+$/, "");
  const lowered = slashed.toLowerCase();
  return lowered;
}