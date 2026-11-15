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

import { randomUUID, createHash } from "crypto";

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
 * Collision-free session key normalization for active request/env identities.
 * Safe <=64-char `[A-Za-z0-9_-]` IDs stay unchanged; any punctuation or
 * overlong ID receives a SHA-256 suffix so distinct identities never collide.
 */
const HASHED_SESSION_KEY_RE = /-h[0-9a-f]{32}$/;

export function canonicalSessionKey(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw) && !HASHED_SESSION_KEY_RE.test(raw)) {
    return raw;
  }
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  // Hash lossless UTF-16 code units so lone surrogates (e.g. "\ud800" vs "\ud801") never collapse to U+FFFD.
  const hash = createHash("sha256").update(Buffer.from(raw, "utf16le")).digest("hex").slice(0, 32);
  const prefix = (cleaned || "session").slice(0, 29).replace(/-+$/g, "") || "session";
  return `${prefix}-h${hash}`;
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
    return { key: canonicalSessionKey(fromRequest), source: "request-metadata" };
  }

  // `metaKey` disediakan untuk pemanggil yang membaca metadata sendiri lalu
  // ingin tetap tercatat sebagai metadata, bukan env.
  const fromMeta = typeof metaKey === "string" ? metaKey.trim() : "";
  if (fromMeta) {
    return { key: canonicalSessionKey(fromMeta), source: "request-metadata" };
  }

  for (const candidate of [
    env?.DEV_WORKFLOW_SESSION_ID,
    env?.OPENCODE_SESSION_ID,
    env?.CLIENT_SESSION_ID,
  ]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return { key: canonicalSessionKey(value), source: "env" };
  }

  return { key: PROCESS_SESSION_KEY, source: "process-random" };
}

/**
 * Menormalkan path proyek menjadi bentuk yang selalu sama.
 *
 * `D:\code\Foo`, `d:/code/foo`, dan `D:\code\Foo\` adalah proyek yang SAMA di
 * Windows. Tanpa normalisasi, ketiganya menjadi tiga baris berbeda dan riwayat
 * sebuah proyek terpecah hanya karena penulisan path berbeda antar pemanggil.
 *
 * MENGAPA PEKA PLATFORM
 * ---------------------
 * Di POSIX, `/srv/App` dan `/srv/app` adalah DUA direktori yang berbeda. Versi
 * pertama fungsi ini mengecilkan SELURUH path, sehingga dua proyek yang tidak
 * berhubungan bergabung menjadi satu baris - riwayatnya tercampur, dan rekap
 * durasi menghitung pekerjaan orang lain.
 *
 * Karena itu huruf besar-kecil diseragamkan HANYA di Windows, tempat sistem
 * berkasnya sendiri tidak membedakannya. Di POSIX, path dikembalikan apa adanya
 * setelah garis miringnya diseragamkan.
 *
 * Jalur akar dipertahankan: `/` tetap `/`, dan `C:\` menjadi `c:/`, bukan string
 * kosong - string kosong berarti "tanpa proyek" dan akan mencampur semuanya.
 */
export function normalizeProjectPath(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text === "") return "";

  const slashed = text.replace(/\\/g, "/");

  // Buang garis miring di akhir, kecuali bila isinya memang hanya garis miring
  // (akar POSIX). Akar drive Windows juga harus mempertahankan garis miringnya:
  // `C:\` menjadi `c:/`, bukan `c:` - bentuk terakhir bukan path yang sah dan
  // akan membingungkan pembaca yang mencoba membukanya.
  let tanpaAkhir = /^\/+$/.test(slashed) ? slashed : slashed.replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(tanpaAkhir)) tanpaAkhir = `${tanpaAkhir}/`;

  if (process.platform === "win32") {
    return tanpaAkhir.toLowerCase();
  }

  // POSIX: path dipertahankan apa adanya setelah garis miring diseragamkan.
  return tanpaAkhir;
}