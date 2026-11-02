'use strict';

/**
 * Halaman publik satu sesi.
 *
 * ATURAN YANG DIJAGA BERKAS INI
 * -----------------------------
 * 1. `PUBLIC_DENY` tidak boleh muncul, baik sebagai NILAI maupun sebagai NAMA
 *    field. Karena itu kelas CSS di sini bernama `kartu`, `chip`, `bar`,
 *    `daftar` - bukan `session-key` atau `machine`. Tes memeriksa HTML hasil
 *    render, bukan kode sumber, sehingga kelas atau atribut baru yang
 *    menyalin nama field akan langsung tertangkap.
 *
 * 2. Semua teks di-escape. Halaman ini dibuka orang yang tidak dikenal, dan
 *    isinya berasal dari judul task yang diketik manusia - termasuk oleh
 *    model. Satu `<script>` yang lolos adalah XSS tersimpan di domain publik.
 *
 * 3. Tanpa JavaScript. CSP-nya `default-src 'none'`, jadi skrip tidak akan
 *    berjalan; menulisnya hanya membuat halaman tampak seperti punya fitur
 *    yang sebenarnya mati.
 *
 * 4. Tidak mengklaim lebih dari yang bisa dibuktikan. Halaman ini adalah
 *    SNAPSHOT saat dimuat, bukan siaran langsung, dan ia menyebut umur
 *    laporan terakhir supaya pembaca bisa menilai sendiri.
 *
 * Berkas ini tidak menyentuh jaringan maupun basis data.
 */

const { PUBLIC_ORIGIN, FALLBACK_ORIGIN, publicUrl } = require('./share-links.cjs');
const { formatDuration } = require('./history-query.cjs');

/**
 * Field yang TIDAK BOLEH sampai ke pembaca tautan.
 *
 * Daftar ini hidup di sini (bukan hanya di komentar) karena tes memakainya
 * untuk memeriksa HTML hasil render. Menambah field sensitif ke query cukup
 * dengan menambahkannya di sini, dan tesnya langsung menagih.
 */
const PUBLIC_DENY = Object.freeze([
  'machine',
  'project_path',
  'project_name',
  'session_key',
  'agent_tool',
  'owner_pid',
]);

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Batas jumlah langkah rencana yang ditampilkan; sisanya disebut jumlahnya. */
const BATAS_LANGKAH = 40;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

/** Header yang sama untuk halaman sukses maupun halaman status. */
function securityHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  };
}

/** Judul: task dulu, lalu judul sesi, lalu sebutan umum. */
function shareTitle(session) {
  const s = session || {};
  const task = String(s.task == null ? '' : s.task).trim();
  if (task) return task;
  const judul = String(s.session_title == null ? '' : s.session_title).trim();
  if (judul) return judul;
  return 'Sesi dev workflow';
}

/** Umur dalam bahasa manusia. Tidak pernah mengembalikan waktu negatif. */
function umur(iso, now) {
  const ms = nowMs(now) - Date.parse(String(iso));
  if (!isFinite(ms)) return null;
  const detik = Math.max(0, Math.floor(ms / 1000));
  if (detik < 10) return 'baru saja';
  if (detik < 60) return detik + ' detik lalu';
  if (detik < 3600) return Math.floor(detik / 60) + ' menit lalu';
  if (detik < 86400) return Math.floor(detik / 3600) + ' jam lalu';
  return Math.floor(detik / 86400) + ' hari lalu';
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = Date.parse(String(now));
  return isFinite(parsed) ? parsed : Date.now();
}

/** Bagian yang bergantung pada isi sesi - dirender terpisah supaya jelas. */
function badanSesi({ session, now }) {
  const s = session || {};
  const bagian = [];

  const tipe = String(s.task_type == null ? '' : s.task_type).trim();
  const fase = String(s.phase == null ? '' : s.phase).trim();
  bagian.push(
    '<p class="meta">' +
      (tipe ? '<span class="chip">' + escapeHtml(tipe) + '</span>' : '') +
      (fase ? '<span class="chip">' + escapeHtml(fase) + '</span>' : '') +
      '</p>',
  );

  const total = Number(s.plan_total) || 0;
  const selesai = Number(s.plan_done) || 0;
  if (total > 0) {
    const pct = Math.min(100, Math.round((selesai / total) * 100));
    bagian.push(
      '<h2>Rencana ' +
        escapeHtml(String(selesai)) +
        ' / ' +
        escapeHtml(String(total)) +
        '</h2>' +
        '<div class="bar"><i style="width:' +
        pct +
        '%"></i></div>',
    );
    const semua = Array.isArray(s.plan_json) ? s.plan_json : [];
    const rencana = semua.slice(0, BATAS_LANGKAH);
    if (rencana.length) {
      bagian.push(
        '<ul class="daftar">' +
          rencana
            .map((p) => {
              const beres = p && p.status === 'done';
              return (
                '<li class="' +
                (beres ? 'beres' : '') +
                '">' +
                (beres ? '✓ ' : '• ') +
                escapeHtml(p && p.text) +
                '</li>'
              );
            })
            .join('') +
          // Memotong daftar tanpa mengatakannya membuat rencana panjang
          // tampak selesai padahal tidak - persis ketidakjujuran yang
          // dihindari di bagian lain halaman ini.
          (semua.length > rencana.length
            ? '<li class="sisa">… dan ' +
              escapeHtml(String(semua.length - rencana.length)) +
              ' langkah lain</li>'
            : '') +
          '</ul>',
      );
    }
  }

  const dodTotal = Number(s.dod_total) || 0;
  const dodDone = Number(s.dod_done) || 0;
  const waived = Number(s.dod_waived) || 0;
  bagian.push(
    '<h2>Definition of Done</h2>' +
      '<p class="besar">' +
      escapeHtml(String(dodDone)) +
      ' / ' +
      escapeHtml(String(dodTotal)) +
      ' terbukti' +
      (waived ? ' · ' + escapeHtml(String(waived)) + ' dilewati' : '') +
      '</p>',
  );

  const durasi = formatDuration(
    s.started_at ? Math.floor((nowMs(now) - Date.parse(String(s.started_at))) / 1000) : null,
  );
  bagian.push(
    '<h2>Waktu</h2>' +
      '<p>' +
      (s.started_at
        ? 'Mulai ' + escapeHtml(umur(s.started_at, now) || '') + ' · berjalan ' + escapeHtml(durasi || '')
        : 'Waktu mulai <b>tidak tercatat</b> (sesi ini dibuat sebelum perbaikan pencatatan waktu)') +
      '</p>' +
      '<p>Laporan terakhir ' + escapeHtml(umur(s.updated_at, now) || 'tidak diketahui') + '</p>',
  );

  return bagian.join('');
}

/**
 * @param {object} args
 * @param {object} args.share   baris share_links (token, created_at, views)
 * @param {object} args.session baris sesi (tanpa field terlarang)
 * @param {string|number|Date} args.now
 * @param {string} [args.origin]         bawaan domain utama
 * @param {string} [args.fallbackOrigin] bawaan subdomain share
 * @returns {string} HTML lengkap
 */
function renderSharePage({ share, session, now = Date.now(), origin = PUBLIC_ORIGIN, fallbackOrigin = FALLBACK_ORIGIN } = {}) {
  const token = String((share && share.token) || '');
  const judul = escapeHtml(shareTitle(session));
  const url = escapeHtml(publicUrl(token, origin));
  const cadangan = escapeHtml(publicUrl(token, fallbackOrigin));
  const tampilan = Number(share && share.views) || 0;

  const deskripsi =
    shareTitle(session) +
    ' · ' +
    String((session && session.phase) || 'idle') +
    ' · DoD ' +
    (Number(session && session.dod_done) || 0) +
    '/' +
    (Number(session && session.dod_total) || 0);

  return `<!doctype html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${judul}</title>
<meta name="description" content="${escapeHtml(deskripsi)}">
<meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dev Workflow">
<meta property="og:title" content="${judul}">
<meta property="og:description" content="${escapeHtml(deskripsi)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${judul}">
<meta name="twitter:description" content="${escapeHtml(deskripsi)}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0f14; color:#e6edf3; }
  .kartu { max-width:640px; margin:0 auto; border:1px solid #21262d; border-radius:12px;
           background:#0f151c; padding:18px; }
  h1 { font-size:20px; margin:0 0 6px; }
  h2 { font-size:13px; margin:18px 0 6px; color:#8b949e; text-transform:uppercase;
       letter-spacing:.5px; font-weight:600; }
  p { margin:4px 0; color:#9da7b3; }
  .besar { font-size:16px; color:#e6edf3; }
  .meta { margin-top:8px; }
  .chip { display:inline-block; background:#1f6feb22; color:#79c0ff; border:1px solid #1f6feb55;
          border-radius:999px; padding:1px 9px; font-size:11px; text-transform:uppercase;
          letter-spacing:.4px; margin-right:6px; }
  .bar { height:6px; background:#21262d; border-radius:999px; overflow:hidden; margin:6px 0; }
  .bar > i { display:block; height:100%; background:#2f81f7; }
  ul.daftar { list-style:none; margin:6px 0 0; padding:0; font-size:14px; }
  ul.daftar li { padding:2px 0; color:#9da7b3; }
  ul.daftar li.beres { color:#3fb950; text-decoration:line-through; }
  .kaki { margin-top:20px; border-top:1px solid #21262d; padding-top:12px;
          font-size:12px; color:#6e7681; word-break:break-all; }
  .kaki a { color:#79c0ff; }
</style></head>
<body>
<div class="kartu">
  <h1>${judul}</h1>
  ${badanSesi({ session, now })}
  <div class="kaki">
    <p>Halaman ini adalah cuplikan keadaan saat dibuka, bukan siaran langsung.
       Bagikan tautannya: <a href="${url}">${url}</a></p>
    <p>Bila domain utama tidak menjawab, coba <a href="${cadangan}">${cadangan}</a></p>
    <p>Dibuka ${escapeHtml(String(tampilan))}× sebelum Anda · tautan dapat dicabut pemiliknya kapan saja.</p>
  </div>
</div>
</body></html>`;
}

/**
 * Halaman untuk 404/410/503. Kalimatnya datang dari pemanggil supaya satu
 * halaman dipakai untuk semua sebab tanpa menyamakan artinya.
 */
function renderStatusPage({ status = 404, message = '', hint = '' } = {}) {
  const kode = Number(status) || 404;
  return `<!doctype html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tautan tidak bisa dibuka</title>
<meta name="robots" content="noindex,nofollow">
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px 20px; font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0f14; color:#e6edf3; }
  .kartu { max-width:560px; margin:0 auto; border:1px solid #21262d; border-radius:12px;
           background:#0f151c; padding:20px; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { color:#9da7b3; margin:6px 0; }
  .kode { color:#8b949e; font-size:12px; letter-spacing:1px; }
</style></head>
<body>
<div class="kartu">
  <div class="kode">HTTP ${escapeHtml(String(kode))}</div>
  <h1>${escapeHtml(message)}</h1>
  ${hint ? '<p>' + escapeHtml(hint) + '</p>' : ''}
</div>
</body></html>`;
}

module.exports = {
  PUBLIC_DENY,
  escapeHtml,
  securityHeaders,
  shareTitle,
  umur,
  renderSharePage,
  renderStatusPage,
};
