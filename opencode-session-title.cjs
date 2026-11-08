'use strict';

/**
 * Judul sesi OpenCode.
 *
 * MENGAPA PERLU
 * -------------
 * Dashboard menampilkan kode sesi (`ses_e6a32...`) yang tidak berarti apa pun
 * bagi pemiliknya. OpenCode menyimpan judul percakapan di `opencode.db`
 * (tabel `session_v2`, kolom `title`), dan `id` di sana SAMA PERSIS dengan
 * `session_key` yang sudah dikirim pelapor. Jadi judulnya bisa ditampilkan
 * tanpa menebak.
 *
 * ATURAN KERAS
 * ------------
 * 1. Tidak pernah melempar dan tidak pernah menahan lama: berkas ini dipanggil
 *    di jalur penyimpanan state, dan database OpenCode bisa saja tidak ada
 *    (mesin lain, CLI tanpa desktop, atau berkas sedang terkunci).
 * 2. Membuka database dalam mode READONLY: kita hanya membaca judul, tidak
 *    boleh menyentuh data percakapan.
 * 3. Hasilnya di-cache singkat: judul jarang berubah, sementara `save()`
 *    dipanggil jauh lebih sering.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/** Berapa lama judul di-cache sebelum dibaca ulang. */
const CACHE_MS = 5 * 60 * 1000;

let cache = new Map();

function normalizeOptions(optsOrEnv) {
  if (!optsOrEnv) return { env: process.env, now: Date.now() };
  if (typeof optsOrEnv === 'object' && ('env' in optsOrEnv || 'now' in optsOrEnv)) {
    return {
      env: optsOrEnv.env || process.env,
      now: typeof optsOrEnv.now === 'number' ? optsOrEnv.now : Date.now(),
    };
  }
  return { env: optsOrEnv, now: Date.now() };
}

/** Lokasi opencode.db yang lazim, sesuai platform. */
function candidatePaths(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const out = [];
  if (env.OPENCODE_DB) out.push(env.OPENCODE_DB);
  if (env.XDG_DATA_HOME) out.push(path.join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  if (home) {
    out.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
    out.push(path.join(home, '.local', 'share', 'opencode', 'db.sqlite'));
    out.push(path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  }
  return out;
}

/**
 * Baca judul satu sesi.
 *
 * @returns {string} judul, atau string kosong bila tidak ditemukan.
 */
function sessionTitle(sessionKey, optsOrEnv) {
  try {
    const { env, now } = normalizeOptions(optsOrEnv);
    const key = String(sessionKey || '');
    if (!key) return '';

    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_MS) return cached.title;

    const file = candidatePaths(env).find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!file) return '';

    // better-sqlite3 adalah dependensi paket ini, tetapi mesin tanpa database
    // tetap harus jalan - karena itu diwajibkan di sini, bukan di atas berkas.
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    let title = '';
    try {
      const row = db.prepare('SELECT title FROM session_v2 WHERE id = ?').get(key);
      title = row && row.title ? String(row.title).slice(0, 200) : '';
    } finally {
      db.close();
    }

    cache.set(key, { title, at: now });
    return title;
  } catch {
    // Judul adalah hiasan; kegagalannya tidak boleh mengganggu apa pun.
    return '';
  }
}

/**
 * Perbarui judul sesi di opencode.db dan sinkronkan ke cache.
 * Dipanggil saat start_task agar judul sesi di OpenCode dan monitor
 * sesuai dengan tugas aktif yang sedang dikerjakan.
 *
 * @param {string} sessionKey
 * @param {string} newTitle
 * @param {{ env?: NodeJS.ProcessEnv, now?: number } | NodeJS.ProcessEnv} [optsOrEnv]
 * @returns {boolean} true bila berhasil diupdate ke db, false bila dilewati/gagal.
 */
function updateSessionTitle(sessionKey, newTitle, optsOrEnv) {
  try {
    const { env, now } = normalizeOptions(optsOrEnv);
    const key = String(sessionKey || '').trim();
    const cleanTitle = String(newTitle || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!key || !cleanTitle) return false;

    // Selalu perbarui cache terlebih dahulu agar pemanggil di proses ini
    // (misalnya monitor snapshot) langsung mendapat judul baru
    cache.set(key, { title: cleanTitle, at: now });

    const file = candidatePaths(env).find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!file) return false;

    const Database = require('better-sqlite3');
    const db = new Database(file, { timeout: 2000 });
    try {
      const stmt = db.prepare('UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?');
      const result = stmt.run(cleanTitle, now, key);
      return result.changes > 0;
    } finally {
      db.close();
    }
  } catch {
    // Penamaan sesi adalah pelengkap UX; tidak boleh memicu kegagalan workflow
    return false;
  }
}

/** Kosongkan cache - dipakai tes. */
function resetTitleCache() {
  cache = new Map();
}

module.exports = { sessionTitle, updateSessionTitle, resetTitleCache, candidatePaths, CACHE_MS };
