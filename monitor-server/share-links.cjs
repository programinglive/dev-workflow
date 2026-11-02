'use strict';

/**
 * Token, URL, dan SQL untuk tautan share publik.
 *
 * MENGAPA SATU TAUTAN HIDUP PER SESI
 * ----------------------------------
 * Menekan Share dua kali tidak boleh membuat tautan baru dan diam-diam
 * mematikan tautan yang sudah dikirim ke WhatsApp. Kalau itu terjadi,
 * orang yang membuka tautan lama mendapat "sudah dicabut" padahal pemiliknya
 * hanya menekan tombol sekali lagi. Karena itu:
 *
 *   - POST /api/share mengembalikan token yang SUDAH ADA bila masih hidup;
 *   - indeks unik parsial `(session_key) WHERE revoked_at IS NULL` menjaga
 *     janji itu di tingkat database, bukan hanya di tingkat kode.
 *
 * MENGAPA TIDAK ADA DELETE
 * ------------------------
 * Menghapus baris membuat "tautan ini dicabut pemiliknya" tidak bisa
 * dibedakan dari "tautan tidak pernah ada". Pencabutan menyetel `revoked_at`,
 * sehingga 410 tetap bisa dijawab dengan benar dan jumlah kunjungan tetap
 * tersimpan untuk pemiliknya.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data, hanya menyusun nilai
 * dan SQL. Itu membuat seluruh aturannya bisa diuji tanpa Postgres.
 */

const crypto = require('node:crypto');

/** Domain yang dipakai di tautan yang dibagikan pemilik. */
const PUBLIC_ORIGIN = 'https://devworkflow.programinglive.com';
/**
 * Jalan kedua bila proxy Netlify bermasalah.
 *
 * Ditampilkan di halaman share, bukan dipakai sebagai tautan utama: pemilik
 * meminta tautan yang dibagikan memakai domain utama.
 *
 * MENGAPA BUKAN `share.devworkflow.programinglive.com`: sertifikat Universal
 * SSL zona ini hanya mencakup `programinglive.com` + `*.programinglive.com`
 * (satu label). Subdomain dua label di bawah titik wildcard gagal handshake
 * TLS. Hostname ini satu label, jadi langsung tercakup, dan ia hanya jalur
 * cadangan - pembaca normal tidak pernah melihatnya.
 */
const FALLBACK_ORIGIN = 'https://devwfshare.programinglive.com';

/** 32 byte acak = 256 bit. Base64url menghasilkan 43 karakter tanpa padding. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * DDL yang aman dijalankan berulang kali oleh proses mana pun.
 *
 * `IF NOT EXISTS` di kedua pernyataan adalah syaratnya: `share-server` dan
 * `dashboard` sama-sama memanggil ini saat boot, dan keduanya boleh jalan
 * bersamaan tanpa gagal.
 */
const ensureTableSql = `
CREATE TABLE IF NOT EXISTS share_links (
  token        text primary key,
  session_key  text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_view_at timestamptz,
  views        integer not null default 0
);
CREATE UNIQUE INDEX IF NOT EXISTS share_links_one_live_per_session
  ON share_links (session_key)
  WHERE revoked_at IS NULL;
`.trim();

/**
 * @param {function} randomBytes disuntikkan supaya bisa diuji; bawaan crypto.
 * @returns {string} token 43 karakter base64url
 */
function generateToken(randomBytes = crypto.randomBytes) {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hanya bentuk yang bisa masuk URL dengan aman yang diterima.
 *
 * Token datang dari path URL, jadi apa pun yang lolos ke sini ikut ke query.
 * Parameter memang dipakai di semua SQL, tetapi menolak bentuk asing lebih
 * awal membuat 404 berarti "tidak ada", bukan "sintaks aneh".
 */
function isValidToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function publicUrl(token, origin = PUBLIC_ORIGIN) {
  return String(origin).replace(/\/+$/, '') + '/s/' + token;
}

function fallbackUrl(token) {
  return publicUrl(token, FALLBACK_ORIGIN);
}

function teks(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * Sisipkan tautan baru. `DO NOTHING` bukan kemalasan: baris yang sudah ada
 * adalah tautan yang sudah tersebar, dan pemanggil akan membacanya kembali
 * lewat `buildLiveLinkQuery`.
 */
function buildInsertLink({ token, sessionKey } = {}) {
  const t = teks(token);
  const key = teks(sessionKey);
  if (!t) throw new Error('token wajib');
  if (!key.trim()) throw new Error('sessionKey wajib');

  return {
    sql: `INSERT INTO share_links (token, session_key)
          VALUES ($1, $2)
          ON CONFLICT (session_key) WHERE revoked_at IS NULL DO NOTHING
          RETURNING token`,
    params: [t, key],
  };
}

/** Tautan hidup milik satu sesi. Dipakai saat Share ditekan untuk kedua kali. */
function buildLiveLinkQuery({ sessionKey } = {}) {
  const key = teks(sessionKey);
  if (!key.trim()) throw new Error('sessionKey wajib');

  return {
    sql: `SELECT token, created_at, views
            FROM share_links
           WHERE session_key = $1
             AND revoked_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
    params: [key],
  };
}

/** Cabut: setel waktu, jangan hapus baris. */
function buildRevokeLink({ token } = {}) {
  const t = teks(token);
  if (!t) throw new Error('token wajib');

  return {
    sql: `UPDATE share_links SET revoked_at = now()
           WHERE token = $1 AND revoked_at IS NULL
           RETURNING token`,
    params: [t],
  };
}

/**
 * Ambil tautan beserta sesinya.
 *
 * LEFT JOIN, bukan INNER JOIN: sesi boleh sudah dibersihkan retensi
 * sementara tautannya masih sah. Dengan INNER JOIN baris itu hilang dan
 * hasilnya 404 yang sama dengan token karangan - padahal keduanya berbeda
 * cerita dan pemiliknya perlu tahu yang mana.
 */
function buildTokenLookup({ token } = {}) {
  const t = teks(token);
  if (!t) throw new Error('token wajib');

  return {
    sql: `SELECT l.token, l.session_key, l.created_at, l.revoked_at, l.views, l.last_view_at,
                 s.session_key AS live_session_key,
                 s.task, s.task_type, s.phase, s.plan_json, s.plan_done, s.plan_total,
                 s.dod_done, s.dod_total, s.dod_waived, s.started_at, s.updated_at,
                 s.session_title
            FROM share_links l
            LEFT JOIN sessions s ON s.session_key = l.session_key
           WHERE l.token = $1`,
    params: [t],
  };
}

/** Menambah kunjungan. Tidak pernah menyentuh tabel `sessions`. */
function buildTouchView({ token } = {}) {
  const t = teks(token);
  if (!t) throw new Error('token wajib');

  return {
    sql: `UPDATE share_links
             SET views = views + 1, last_view_at = now()
           WHERE token = $1`,
    params: [t],
  };
}

/** Semua tautan hidup, untuk ditampilkan di kartu dashboard. */
function buildLiveSharesQuery() {
  return {
    sql: `SELECT session_key, token, created_at, views, last_view_at
            FROM share_links
           WHERE revoked_at IS NULL
           ORDER BY created_at DESC`,
    params: [],
  };
}

/**
 * Terjemahkan satu baris hasil `buildTokenLookup` menjadi kode HTTP.
 *
 * 410 dipakai khusus untuk "sengaja dimatikan". Token karangan dan sesi yang
 * sudah dibuang sama-sama 404, tetapi `reason` membedakannya supaya halaman
 * bisa memakai kalimat yang benar.
 */
function classifyShareLookup(row) {
  if (!row) return { status: 404, reason: 'unknown' };
  if (row.revoked_at) return { status: 410, reason: 'revoked' };
  if (!row.live_session_key) return { status: 404, reason: 'session_gone' };
  return { status: 200, reason: 'ok' };
}

module.exports = {
  PUBLIC_ORIGIN,
  FALLBACK_ORIGIN,
  TOKEN_BYTES,
  ensureTableSql,
  generateToken,
  isValidToken,
  publicUrl,
  fallbackUrl,
  buildInsertLink,
  buildLiveLinkQuery,
  buildRevokeLink,
  buildTokenLookup,
  buildTouchView,
  buildLiveSharesQuery,
  classifyShareLookup,
};
