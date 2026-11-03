'use strict';

/**
 * Server publik untuk satu tautan share.
 *
 * MENGAPA PROSES TERPISAH, DAN HANYA BACA
 * ---------------------------------------
 * Proses ini menghadap internet (lewat Cloudflare Tunnel). Dashboard di port
 * 3100 memegang wewenang menulis - membuat dan mencabut tautan - dan hanya
 * terjangkau dari tailnet. Memisahkannya berarti permukaan yang terbuka tidak
 * punya satu pun jalur tulis: tidak ada POST, tidak ada DELETE, tidak ada
 * token rahasia di dalamnya.
 *
 * Bila konsolidasi terasa lebih rapi, ingat harganya: satu kesalahan routing
 * di dashboard berubah menjadi "siapa pun di internet bisa membuat tautan atas
 * nama pemilik".
 *
 * MENGAPA BIND 127.0.0.1
 * ----------------------
 * Sama seperti dashboard: bind ke 0.0.0.0 akan membuka port 3200 langsung ke
 * internet tanpa TLS dan tanpa Cloudflare di depannya. Tunnel-lah yang
 * menyediakan jalur publiknya.
 *
 * Berkas ini tidak membuat koneksi database sendiri saat diimpor; `main()`
 * melakukannya, sehingga tes bisa menyuntikkan `query` palsu.
 */

const http = require('node:http');
const {
  isValidToken,
  buildTokenLookup,
  buildTouchView,
  classifyShareLookup,
} = require('./share-links.cjs');
const { securityHeaders, renderSharePage, renderStatusPage } = require('./share-page.cjs');
const { clientKey } = require('./client-key.cjs');

const DEFAULT_PORT = 3200;
const DEFAULT_HOST = '127.0.0.1';
/** Batas kunjungan per IP per menit. Cukup longgar untuk grup WhatsApp. */
const DEFAULT_RATE_LIMIT = 120;
const WINDOW_MS = 60 * 1000;

/** Pesan yang dibedakan dengan sengaja: tiap sebab punya kalimatnya sendiri. */
const PESAN = {
  unknown: {
    message: 'Tautan tidak dikenal.',
    hint: 'Periksa kembali tautannya - mungkin ada karakter yang terpotong saat disalin.',
  },
  session_gone: {
    message: 'Sesi yang dibagikan sudah tidak tersimpan.',
    hint: 'Tautannya sah, tetapi data sesinya sudah dibersihkan. Minta pemilik membagikan ulang.',
  },
  revoked: {
    message: 'Tautan ini sudah dicabut pemiliknya.',
    hint: 'Hubungi pemilik bila Anda masih memerlukan status pekerjaan itu.',
  },
};

/**
 * @param {{ pathname: string, method: string }} args
 * @returns {{kind:'page',token:string}|{kind:'health'}|{kind:'method'}|{kind:'missing'}}
 */
function routeShare({ pathname, method } = {}) {
  const path = typeof pathname === 'string' ? pathname : '/';
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';

  if (path === '/health') return { kind: 'health' };

  if (path === '/s' || path === '/s/') return { kind: 'missing' };
  if (path.startsWith('/s/')) {
    const token = path.slice(3);
    // Token berbentuk salah BUKAN 405 walau metodenya GET: itu 404. Metode
    // yang diperiksa sesudah token, supaya POST ke path ngawur tetap 404 dan
    // tidak memberi kesan endpoint itu ada.
    if (!isValidToken(token)) return { kind: 'missing' };
    if (verb !== 'GET' && verb !== 'HEAD') return { kind: 'method' };
    return { kind: 'page', token };
  }

  return { kind: 'missing' };
}

function kirim(res, status, headers, body, { head = false } = {}) {
  res.writeHead(status, headers);
  if (head) return res.end();
  return res.end(body);
}

function kirimHtml(res, status, html, { head = false } = {}) {
  return kirim(res, status, securityHeaders(), html, { head });
}

function kirimJson(res, status, obj, extra = {}) {
  return kirim(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, JSON.stringify(obj));
}

/**
 * Pembatas laju sederhana: jendela tetap per IP.
 *
 * Tanpa ini satu tautan yang bocor ke grup besar bisa menghantam Postgres
 * tanpa batas. Nilainya sengaja longgar - ini pengaman, bukan pagar.
 *
 * BATAS KERAS UKURAN PETA
 * -----------------------
 * Versi pertama hanya membersihkan entri kedaluwarsa saat kunci baru masuk.
 * Itu tidak cukup: penyerang yang memutar IP membuat SEMUA entri masih segar,
 * jadi tidak satu pun dibuang dan peta tumbuh mengikuti jumlah permintaan.
 * Pada proses yang hidup berhari-hari itu kebocoran memori.
 *
 * Karena itu ada dua lapis: buang entri kedaluwarsa, DAN bila masih melewati
 * BATAS_KUNCI, buang yang paling tua sampai di bawah batas. Yang dibuang
 * hanya riwayat hitungan, bukan izin - pembaca yang dibuang catatannya
 * memulai jendela baru, dan itu jauh lebih baik daripada server kehabisan
 * memori.
 */
function buatPembatas({ perMenit = DEFAULT_RATE_LIMIT, sekarang = Date.now } = {}) {
  const hitungan = new Map();
  /** Di atas ini, entri tertua dibuang - berapa pun umurnya. */
  const BATAS_KUNCI = 5000;

  function bersihkan(now) {
    for (const [k, v] of hitungan) {
      if (now - v.mulai >= WINDOW_MS) hitungan.delete(k);
    }
    if (hitungan.size <= BATAS_KUNCI) return;
    // Map menjaga urutan sisip, jadi yang paling awal adalah yang paling tua.
    for (const k of hitungan.keys()) {
      if (hitungan.size <= BATAS_KUNCI) break;
      hitungan.delete(k);
    }
  }

  function izinkan(ip) {
    const now = sekarang();
    const kunci = String(ip || 'unknown');
    const catatan = hitungan.get(kunci);
    if (!catatan || now - catatan.mulai >= WINDOW_MS) {
      hitungan.set(kunci, { mulai: now, n: 1 });
      // Jaga peta tidak tumbuh selamanya pada proses yang hidup berhari-hari.
      if (hitungan.size > BATAS_KUNCI) bersihkan(now);
      return true;
    }
    catatan.n += 1;
    return catatan.n <= perMenit;
  }

  /** Jumlah kunci aktif; dipakai tes dan pemantauan. */
  izinkan.ukuran = function ukuran() {
    return hitungan.size;
  };

  return izinkan;
}

/**
 * @param {object} args
 * @param {function} args.query   (sql, params) => Promise<{rows, rowCount}>
 * @param {boolean} [args.enableRateLimit]
 * @param {number} [args.rateLimitPerMinute]
 * @param {function} [args.now]
 * @returns {http.Server} belum listen
 */
function createShareServer({
  query,
  enableRateLimit = true,
  rateLimitPerMinute = DEFAULT_RATE_LIMIT,
  now = Date.now,
} = {}) {
  if (typeof query !== 'function') throw new Error('query wajib');

  const izinkan = enableRateLimit ? buatPembatas({ perMenit: rateLimitPerMinute, sekarang: now }) : () => true;

  return http.createServer(async (req, res) => {
    try {
      // URL diparse DI DALAM try: target permintaan yang rusak akan melempar,
      // dan tanpa ini lemparannya menjadi unhandled rejection di callback
      // server - bukan 400 yang jujur.
      const url = new URL(req.url, 'http://x');
      const rute = routeShare({ pathname: url.pathname, method: req.method });

      if (rute.kind === 'health') {
        return kirimJson(res, 200, { ok: true, at: new Date().toISOString() });
      }
      if (rute.kind === 'method') {
        return kirim(res, 405, { 'content-type': 'text/plain', allow: 'GET, HEAD', 'cache-control': 'no-store' }, 'method not allowed');
      }
      if (rute.kind !== 'page') {
        return kirimHtml(res, 404, renderStatusPage({ status: 404, ...PESAN.unknown }), {
          head: req.method === 'HEAD',
        });
      }

      /**
       * Kunci memakai `clientKey`, bukan `socket.remoteAddress` mentah.
       *
       * Di balik Cloudflare Tunnel, remoteAddress SELALU 127.0.0.1 - itu
       * cloudflared, bukan pembaca. Memakainya berarti semua pembaca berbagi
       * satu kuota, dan satu orang yang membuka tautan 120 kali memblokir
       * semua orang lain.
       */
      const ip = clientKey({ remoteAddress: req.socket && req.socket.remoteAddress, headers: req.headers });
      if (!izinkan(ip)) {
        return kirim(res, 429, { 'content-type': 'text/plain', 'retry-after': '60', 'cache-control': 'no-store' }, 'too many requests');
      }

      const cari = buildTokenLookup({ token: rute.token });
      const hasil = await query(cari.sql, cari.params);
      const baris = hasil && hasil.rows && hasil.rows[0];
      const kelas = classifyShareLookup(baris);

      if (kelas.status !== 200) {
        const pesan = PESAN[kelas.reason] || PESAN.unknown;
        return kirimHtml(res, kelas.status, renderStatusPage({ status: kelas.status, ...pesan }), {
          head: req.method === 'HEAD',
        });
      }

      const html = renderSharePage({
        share: { token: rute.token, created_at: baris.created_at, views: baris.views },
        session: baris,
        now: now(),
      });

      // Balasan dikirim LEBIH DULU, penghitung kunjungan menyusul.
      // Membalik urutannya berarti pembaca menunggu satu tulis database yang
      // tidak ia butuhkan, dan kegagalan tulis itu menjadi kegagalan halaman.
      kirimHtml(res, 200, html, { head: req.method === 'HEAD' });

      /**
       * HANYA `GET` yang dihitung sebagai kunjungan.
       *
       * `HEAD` dipakai crawler pratinjau WhatsApp dan uptime monitor: mereka
       * tidak membuka halaman, mereka hanya memeriksa. Diukur 3 November 2026:
       * 3 GET menaikkan views 0 → 3 (benar), lalu satu HEAD menaikkannya → 4.
       * Angka "dibuka N×" yang dibaca pemilik jadi bukan jumlah manusia, dan
       * tidak ada cara mempercayainya.
       */
      if (req.method !== 'GET') return undefined;

      const sentuh = buildTouchView({ token: rute.token });
      Promise.resolve()
        .then(() => query(sentuh.sql, sentuh.params))
        .catch(() => {
          // Gagal menghitung kunjungan tidak boleh terlihat oleh pembaca.
        });
      return undefined;
    } catch (error) {
      const status = error && error.code === '42P01' ? 503 : 500;
      const pesan =
        status === 503
          ? 'Tabel share_links belum ada di database.'
          : 'Server gagal membaca data sesi.';
      const hint =
        status === 503
          ? 'Operator perlu menjalankan CREATE TABLE share_links - perintahnya tercetak di log share-server.'
          : 'Coba lagi beberapa saat lagi.';
      try {
        kirimHtml(res, status, renderStatusPage({ status, message: pesan, hint }), {
          head: req.method === 'HEAD',
        });
      } catch {
        // Soket sudah tertutup; tidak ada yang bisa dikirim.
      }
      return undefined;
    }
  });
}

/** Titik masuk produksi. Dipanggil hanya bila berkas ini dijalankan langsung. */
async function main() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || DEFAULT_HOST;
  const databaseUrl = process.env.DATABASE_URL || '';

  if (!databaseUrl) {
    console.error(
      'FATAL: DATABASE_URL kosong. Server share tanpa database hanya bisa menjawab 503,\n' +
        'jadi ia berhenti sekarang alih-alih tampak sehat. Isi DATABASE_URL di\n' +
        '/etc/devwf-monitor.env (mode 600), lalu jalankan ulang service.',
    );
    process.exit(1);
  }

  let pg;
  try {
    pg = require('pg');
  } catch {
    console.error('FATAL: paket pg tidak ditemukan di node_modules. Salin dari /opt/devwf-monitor.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const query = (sql, params) => pool.query(sql, params);

  const { ensureTableSql } = require('./share-links.cjs');
  try {
    await query(ensureTableSql);
    console.log('share_links siap.');
  } catch (error) {
    console.error('GAGAL menyiapkan tabel share_links:', String((error && error.message) || error));
    console.error('Jalankan perintah ini sekali sebagai user database aplikasi:\n' + ensureTableSql);
  }

  const server = createShareServer({ query });
  server.listen(port, host, () => {
    console.log(`devwf-share listening on ${host}:${port}`);
  });
}

if (require.main === module) {
  void main();
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_RATE_LIMIT,
  buatPembatas,
  createShareServer,
  routeShare,
};
