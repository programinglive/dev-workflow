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
 *   1. Header `X-Devwf-Share: 1` - penanda protokol. Formulir HTML biasa tidak
 *      bisa mengirim header ini.
 *   2. `Origin` yang dikenal, bila ada.
 *
 * APA YANG SEBENARNYA MENAHAN SERANGAN
 * ------------------------------------
 * Jangan salah membaca: yang menahan tulisan lintas-situs adalah CORS, bukan
 * header itu sendiri. Halaman web di browser pemilik BISA mengirim
 * `x-devwf-share: 1`, tetapi permintaannya lebih dulu melewati preflight, dan
 * preflight itulah yang ditolak. Header penanda hanya membuat permintaan tidak
 * lagi "simple request", sehingga preflight-nya benar-benar terjadi.
 *
 * Versi pertama komentar ini mengklaim header-nya sendiri yang menahan
 * serangan. Itu keliru, dan keliru dengan cara yang berbahaya: ia membuat
 * orang mengira CORS boleh dilonggarkan. Karena itu `OPTIONS` sekarang
 * dijawab eksplisit - lihat `shareGuard` dan pemanggilnya.
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
  buildOrphanCountQuery,
  buildRevokeOrphans,
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
 * @returns {{ ok: true, preflight?: boolean } | { ok: false, status: 403, error: 'forbidden' }}
 */
function shareGuard({ headers, allowedOrigins = [], method } = {}) {
  const h = headers || {};
  if (teks(h[SHARE_HEADER]) !== '1') {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const origin = h.origin;
  const adaOrigin = !(origin === undefined || origin === null || teks(origin) === '');
  // Tidak ada Origin = aplikasi native. Bukan alasan untuk menolak.
  if (adaOrigin && !isOriginAllowed(origin, allowedOrigins)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  // Preflight dari origin yang sah dijawab 204 oleh pemanggil, bukan 405.
  // Tanpa ini, satu-satunya yang menahan tulisan lintas-situs adalah
  // ketiadaan header CORS - kebetulan yang bisa hilang pada perubahan berikutnya.
  if (String(method || '').toUpperCase() === 'OPTIONS') {
    return { ok: true, preflight: true };
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
 *
 * BALAPAN, DAN MENGAPA BUKAN 500
 * ------------------------------
 * Dua tab yang menekan Bagikan bersamaan sama-sama lolos pemeriksaan sesi.
 * Satu menang; yang kalah mendapat `DO NOTHING` dan harus membaca tautan si
 * pemenang. Celahnya: bila pemenang mencabut tautannya tepat di antara
 * sisipan dan pembacaan, yang kalah menemukan tidak ada baris hidup dan
 * mencoba sekali lagi.
 *
 * Versi pertama melempar galat setelah satu percobaan ulang, dan itu menjadi
 * **500** bagi pemilik yang tidak melakukan kesalahan apa pun. Sekarang
 * pembacaan diulang beberapa kali, lalu berhenti dengan 409 - "coba lagi",
 * bukan "server rusak".
 */
const PERCOBAAN_MAKS = 3;

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

    for (let percobaan = 0; percobaan < PERCOBAAN_MAKS; percobaan += 1) {
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
      if (baris) {
        return {
          status: 200,
          body: tautanBody(baris.token, { createdAt: baris.created_at, views: baris.views }),
        };
      }
      // Tidak ada pemenang yang bisa dibaca - dicabut di tengah jalan. Ulangi.
    }

    // Tiga percobaan habis: tab lain terus berlomba mencabut dan membuat.
    // Mengatakannya apa adanya lebih baik daripada mengarang 500 atau
    // mengembalikan tautan yang mungkin sudah mati.
    return {
      status: 409,
      body: { ok: false, error: 'tautan sedang dibuat ulang oleh permintaan lain, coba lagi' },
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
 *
 * DIBATASI: dashboard menyegarkan diri tiap 3 detik, dan setiap tautan yang
 * pernah dibuat tetap hidup sampai dicabut. Tanpa batas, riwayat berbulan-bulan
 * ikut terkirim di setiap poll dan layar tablet membayarnya.
 */
const BATAS_TAUTAN_HIDUP = 200;

async function listLiveShares({ query, limit = BATAS_TAUTAN_HIDUP } = {}) {
  try {
    const { sql, params } = buildLiveSharesQuery({ limit });
    const hasil = await query(sql, params);
    return ((hasil && hasil.rows) || []).map((r) => ({
      sessionKey: r.session_key,
      token: r.token,
      url: publicUrl(r.token, PUBLIC_ORIGIN),
      views: Number(r.views) || 0,
      createdAt: r.created_at || null,
      lastViewAt: r.last_view_at || null,
      // Nama yang bisa dibaca manusia. Kosong berarti sesinya sudah dibersihkan
      // retensi - tautannya tetap hidup dan tetap harus bisa dicabut.
      label: labelSesi(r),
      sessionGone: !r.live_session_key,
      phase: r.phase || null,
    }));
  } catch {
    return [];
  }
}

/** Nama yang ditampilkan untuk satu tautan; tidak pernah kosong. */
function labelSesi(r) {
  const task = teks(r && r.task).trim();
  if (task) return task;
  const judul = teks(r && r.session_title).trim();
  if (judul) return judul;
  const kunci = teks(r && r.session_key);
  if (kunci) return kunci.slice(0, 24);
  return '(tanpa nama)';
}

/** Semua tautan hidup, dipakai panel dashboard. */
async function handleListAllShares({ query } = {}) {
  const shares = await listLiveShares({ query });
  /**
   * Jumlah yatim diambil dari COUNT, bukan dari `shares`.
   *
   * `listLiveShares` dibatasi 200 baris; menghitung yatim di dalamnya
   * melaporkan angka yang salah begitu tautan hidup melewati batas itu, dan
   * angka itu yang menentukan apakah tombol "Cabut yang yatim" muncul.
   */
  let orphanCount = 0;
  try {
    const { sql, params } = buildOrphanCountQuery();
    const hasil = await query(sql, params);
    orphanCount = Number((hasil && hasil.rows && hasil.rows[0] && hasil.rows[0].n) || 0);
  } catch {
    // Panel tetap berguna tanpa angka; jangan jatuhkan seluruh daftar.
    orphanCount = shares.filter((s) => s.sessionGone).length;
  }
  return { status: 200, body: { ok: true, shares, orphanCount, total: shares.length } };
}

/**
 * Cabut semua tautan yang sesinya sudah hilang, sekaligus.
 *
 * MENGAPA AMAN DIJALANKAN TANPA BERTANYA: syaratnya "baris sesinya tidak ada",
 * bukan "sudah lama". Tautan yang masih punya sesi - termasuk sesi `idle` yang
 * baru hilang dari layar - TIDAK tersentuh, karena masih bisa menampilkan
 * sesuatu. Yang dicabut hanya tautan yang halamannya tidak punya isi lagi.
 */
async function revokeOrphanShares({ query } = {}) {
  try {
    const { sql, params } = buildRevokeOrphans();
    const hasil = await query(sql, params);
    const revoked = (hasil && (hasil.rowCount || (hasil.rows && hasil.rows.length))) || 0;
    return { status: 200, body: { ok: true, revoked } };
  } catch (error) {
    return gagal(error);
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
  handleListAllShares,
  revokeOrphanShares,
  labelSesi,
  listLiveShares,
};
