'use strict';

/**
 * Penjaga dan handler untuk tautan share.
 *
 * MENGAPA PENJAGA INI ADA
 * -----------------------
 * Port 3100 hanya terjangkau dari dalam tailnet, jadi penyerang di internet
 * tidak bisa memanggilnya. Yang tetap bisa adalah HALAMAN WEB LAIN yang
 * dibuka di browser pemilik, di perangkat yang memang ada di tailnet: cukup
 * `fetch('http://100.107.65.21:3100/api/share', { method:'POST' })`, dan
 * tautan share baru saja dibuat atas nama pemilik.
 *
 * Karena itu ada dua syarat:
 *
 *   1. Header `X-Devwf-Share: 1` - header ajaib tidak bisa dikirim oleh
 *      formulir HTML biasa maupun permintaan "simple request", jadi ia
 *      memaksa preflight. Ini bukan autentikasi; ini penanda protokol.
 *   2. `Origin` yang dikenal, bila ada.
 *
 * MENGAPA ORIGIN KOSONG DIBERI LALU
 * ---------------------------------
 * Aplikasi tablet (React Native) TIDAK mengirim `Origin` - ia bukan browser
 * dan tidak punya konsep origin. Menolak permintaan tanpa Origin berarti
 * tombol Bagikan di tablet selalu 403, dan itu bagian yang paling sulit
 * didiagnosis karena di dashboard browser semuanya tampak normal.
 *
 * Origin yang ADA tetap diperiksa ketat: perbandingan string penuh, bukan
 * awalan. `http://localhost:3100.evil.example` harus ditolak.
 *
 * Berkas ini tidak membuka socket sendiri; `query` disuntikkan supaya bisa
 * diuji tanpa Postgres.
 */

const {
  PUBLIC_ORIGIN,
  FALLBACK_ORIGIN,
  generateToken,
  isValidToken,
  publicUrl,
  fallbackUrl,
  buildInsertLink,
  buildLiveLinkQuery,
  buildRevokeLink,
  buildLiveSharesQuery,
} = require('./share-links.cjs');

/** Header penanda protokol. Nilainya harus persis "1". */
const SHARE_HEADER = 'x-devwf-share';

function teks(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Perbandingan origin penuh; daftar dibandingkan apa adanya. */
function isOriginAllowed(origin, allowedOrigins = []) {
  const o = teks(origin);
  if (!o) return false;
  const daftar = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return daftar.some((izin) => teks(izin) === o);
}

/**
 * @returns {{ ok: true } | { ok: false, status: 403, error: 'forbidden' }}
 */
function shareGuard({ headers, allowedOrigins = [] } = {}) {
  const h = headers || {};
  if (teks(h[SHARE_HEADER]) !== '1') {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const origin = h.origin;
  // Tidak ada Origin = aplikasi native. Bukan alasan untuk menolak.
  if (origin === undefined || origin === null || teks(origin) === '') {
    return { ok: true };
  }
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true };
}

/**
 * Tabel yang belum ada bukan kesalahan server biasa: itu tanda deploy belum
 * lengkap. 503 memberi tahu operator "perbaiki dulu", sedangkan 500 membuat
 * orang menebak-nebak.
 */
function shareErrorStatus(error) {
  const code = error && error.code;
  const pesan = String((error && error.message) || '');
  if (code === '42P01') return 503;
  if (/share_links/i.test(pesan) && /(does not exist|belum ada)/i.test(pesan)) return 503;
  return 500;
}

function gagal(error) {
  return {
    status: shareErrorStatus(error),
    body: { ok: false, error: String((error && error.message) || error) },
  };
}

/** Bentuk balasan yang sama dipakai create dan list, supaya klien sederhana. */
function tautanBody(token, { createdAt, views } = {}) {
  return {
    token,
    url: publicUrl(token, PUBLIC_ORIGIN),
    fallbackUrl: fallbackUrl(token),
    createdAt: createdAt || null,
    views: Number(views) || 0,
  };
}

/**
 * Buat tautan untuk satu sesi.
 *
 * Urutannya penting: sesi diperiksa LEBIH DULU. Menyisipkan tautan untuk sesi
 * yang tidak ada akan meninggalkan baris yatim yang tidak bisa dibuka siapa
 * pun dan tidak bisa dijelaskan pemiliknya.
 */
async function handleCreateShare({ query, sessionKey } = {}) {
  const key = teks(sessionKey);
  if (!key.trim()) {
    return { status: 400, body: { ok: false, error: 'sessionKey wajib' } };
  }

  try {
    const ada = await query('SELECT 1 FROM sessions WHERE session_key = $1', [key]);
    if (!ada || !ada.rows || ada.rows.length === 0) {
      return { status: 404, body: { ok: false, error: 'sesi tidak ditemukan' } };
    }

    const insert = buildInsertLink({ token: generateToken(), sessionKey: key });
    const dibuat = await query(insert.sql, insert.params);

    if (dibuat && dibuat.rows && dibuat.rows.length > 0) {
      return { status: 200, body: tautanBody(dibuat.rows[0].token, { views: 0 }) };
    }

    // DO NOTHING berarti sudah ada tautan hidup: kembalikan yang itu, jangan
    // membuat tautan kedua yang mematikan tautan pertama secara diam-diam.
    const lama = buildLiveLinkQuery({ sessionKey: key });
    const hasil = await query(lama.sql, lama.params);
    const baris = hasil && hasil.rows && hasil.rows[0];
    if (!baris) {
      // Balapan: baris ada lalu dicabut di antara dua query. Coba sekali lagi
      // dengan token baru, dan berhenti bila masih gagal.
      const ulang = buildInsertLink({ token: generateToken(), sessionKey: key });
      const kedua = await query(ulang.sql, ulang.params);
      const tokenKedua = kedua && kedua.rows && kedua.rows[0] && kedua.rows[0].token;
      if (!tokenKedua) throw new Error('gagal membuat tautan share');
      return { status: 200, body: tautanBody(tokenKedua, { views: 0 }) };
    }
    return {
      status: 200,
      body: tautanBody(baris.token, { createdAt: baris.created_at, views: baris.views }),
    };
  } catch (error) {
    return gagal(error);
  }
}

/** Cabut: idempoten. Mencabut dua kali tetap 200 dengan revoked 0. */
async function handleRevokeShare({ query, token } = {}) {
  const t = teks(token);
  if (!isValidToken(t)) {
    return { status: 400, body: { ok: false, error: 'token tidak sah' } };
  }
  try {
    const { sql, params } = buildRevokeLink({ token: t });
    const hasil = await query(sql, params);
    return { status: 200, body: { ok: true, revoked: (hasil && hasil.rowCount) || 0 } };
  } catch (error) {
    return gagal(error);
  }
}

/** Tautan hidup milik satu sesi, atau `url: null` bila belum ada. */
async function handleListShares({ query, sessionKey } = {}) {
  const key = teks(sessionKey);
  if (!key.trim()) {
    return { status: 400, body: { ok: false, error: 'sessionKey wajib' } };
  }
  try {
    const { sql, params } = buildLiveLinkQuery({ sessionKey: key });
    const hasil = await query(sql, params);
    const baris = hasil && hasil.rows && hasil.rows[0];
    if (!baris) {
      return { status: 200, body: { ok: true, url: null, token: null, views: 0 } };
    }
    return {
      status: 200,
      body: { ok: true, ...tautanBody(baris.token, { createdAt: baris.created_at, views: baris.views }) },
    };
  } catch (error) {
    return gagal(error);
  }
}

/**
 * Semua tautan hidup, untuk ditempel ke kartu dashboard.
 *
 * Kegagalan menjadi array kosong - BUKAN lemparan - karena satu tabel yang
 * belum ada tidak boleh membuat dashboard berhenti menampilkan sesi.
 */
async function listLiveShares({ query } = {}) {
  try {
    const { sql, params } = buildLiveSharesQuery();
    const hasil = await query(sql, params);
    return ((hasil && hasil.rows) || []).map((r) => ({
      sessionKey: r.session_key,
      token: r.token,
      url: publicUrl(r.token, PUBLIC_ORIGIN),
      views: Number(r.views) || 0,
      createdAt: r.created_at || null,
      lastViewAt: r.last_view_at || null,
    }));
  } catch {
    return [];
  }
}

module.exports = {
  SHARE_HEADER,
  shareGuard,
  isOriginAllowed,
  shareErrorStatus,
  handleCreateShare,
  handleRevokeShare,
  handleListShares,
  listLiveShares,
};
