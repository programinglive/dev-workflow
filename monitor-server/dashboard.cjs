'use strict';
/*
 * Live monitor for dev-workflow MCP sessions.
 *
 * WHY A SEPARATE PROCESS: the MCP server is spawned per OpenCode session and
 * killed with it. The dashboard and the Postgres connection must outlive that,
 * so state is pushed from the server (fire and forget) and read here.
 *
 * Zero dependencies on purpose: it must start on a host with no node_modules.
 */
const http = require('node:http');
const pg = require('pg');
const { buildSessionsQuery } = require('./sessions-query.cjs');
const {
  buildPruneEventsQuery,
  buildPruneSessionsQuery,
  isWriteAuthorized,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
} = require('./retention.cjs');
const { buildHealth, DEFAULT_STALE_AFTER_MS } = require('./health.cjs');
const { buildMachinesQuery, DEFAULT_STALE_AFTER_DAYS } = require('./machines-query.cjs');
const { dedupeSessions } = require('./dedupe-sessions.cjs');
const { buildHistoryQuery, formatDuration, DEFAULT_HISTORY_DAYS } = require('./history-query.cjs');
const {
  buildAlerts,
  DEFAULT_STUCK_ALERT_MS,
  DEFAULT_MACHINE_SILENT_MS,
} = require('./alerts.cjs');
const {
  buildProjectSummaryQuery,
  formatDuration: formatDurationSummary,
  DEFAULT_SUMMARY_DAYS,
} = require('./project-summary.cjs');
const { classifySession, LABELS, DEFAULT_LIVE_MS, DEFAULT_STUCK_MS } = require('./status.cjs');
const { buildSessionUpsert } = require('./session-upsert.cjs');
const {
  shareGuard,
  handleCreateShare,
  handleRevokeShare,
  handleListShares,
  handleListAllShares,
  revokeOrphanShares,
  listLiveShares,
} = require('./share-route.cjs');
const { ensureTableSql } = require('./share-links.cjs');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const DB_URL = process.env.DATABASE_URL || '';
const POLL_MS = 3000;
/**
 * Origin yang boleh membuat/mencabut tautan share.
 *
 * Dashboard dibuka dari IP Tailscale atau dari localhost saat dikembangkan.
 * `DEVWF_SHARE_ORIGINS` menambah tanpa mengganti, supaya mesin lain dengan
 * alamat tailnet sendiri tidak perlu menambal berkas ini.
 */
const SHARE_ORIGINS = String(
  process.env.DEVWF_SHARE_ORIGINS || 'http://100.107.65.21:3100,http://localhost:3100',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * Token bersama untuk endpoint TULIS.
 *
 * Membaca tetap bebas - dashboard harus terbuka tanpa login. Menulis tidak:
 * tanpa ini, perangkat mana pun di tailnet bisa mengirim sesi palsu ke layar
 * tablet. Kosong berarti SEMUA penulisan ditolak, bukan diterima.
 */
const WRITE_TOKEN = process.env.DEVWF_MONITOR_TOKEN || '';
/**
 * Token lama yang SEMENTARA masih diterima, dipakai saat rotasi.
 *
 * Tanpa ini, mengganti token berarti setiap mesin yang belum diperbarui
 * langsung ditolak 401 dan kartunya hilang diam-diam - kegagalan yang baru
 * ketahuan berhari-hari kemudian. Dicabut dengan mengosongkan variabelnya
 * sesudah semua mesin diperbarui.
 */
const WRITE_TOKEN_PREVIOUS = process.env.DEVWF_MONITOR_TOKEN_PREVIOUS || '';
/**
 * Retensi: MATI secara bawaan.
 *
 * ATURAN: data monitor tidak boleh terhapus tanpa persetujuan eksplisit.
 * Penghapusan otomatis yang menyala sendiri adalah cara paling mudah
 * kehilangan riwayat tanpa ada yang menyadarinya, dan itu tidak boleh terjadi
 * pada data yang dianggap penting oleh pemiliknya.
 *
 * Untuk menyalakannya, isi `PRUNE_ENABLED=1` di /etc/devwf-monitor.env.
 * Tanpa itu, `pruneOldRows()` tidak menyentuh apa pun.
 */
const PRUNE_ENABLED = String(process.env.PRUNE_ENABLED || '').toLowerCase();
const PRUNE_ON = PRUNE_ENABLED === '1' || PRUNE_ENABLED === 'true' || PRUNE_ENABLED === 'yes';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
const SESSION_RETENTION_DAYS = Number(
  process.env.SESSION_RETENTION_DAYS || DEFAULT_SESSION_RETENTION_DAYS,
);
/** Seberapa sering pembersihan dijalankan. */
const PRUNE_EVERY_MS = Number(process.env.PRUNE_EVERY_MS || 6 * 60 * 60 * 1000);
/** Dianggap basi bila tidak ada laporan apa pun selama ini. */
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS || DEFAULT_STALE_AFTER_MS);
/** Batas "masih bekerja aktif" dan "mungkin berakhir" untuk sesi non-idle. */
const LIVE_MS = Number(process.env.LIVE_MS || DEFAULT_LIVE_MS);
const STUCK_MS = Number(process.env.STUCK_MS || DEFAULT_STUCK_MS);
/** Mesin dianggap basi bila tidak melapor selama ini. Tetap ditampilkan. */
const STALE_AFTER_DAYS = Number(
  process.env.MACHINE_STALE_AFTER_DAYS || DEFAULT_STALE_AFTER_DAYS,
);
/** Berapa hari sesi selesai tetap tampil di riwayat. */
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || DEFAULT_HISTORY_DAYS);
/**
 * Kapan monitor mulai memberi tahu, bukan hanya menunggu dilihat.
 *
 * Ambangnya sengaja longgar. Peringatan yang berbunyi terlalu sering akan
 * diabaikan, dan itu sama saja dengan tidak punya peringatan.
 */
const STUCK_ALERT_MS = Number(process.env.STUCK_ALERT_MS || DEFAULT_STUCK_ALERT_MS);
const MACHINE_SILENT_MS = Number(
  process.env.MACHINE_SILENT_MS || DEFAULT_MACHINE_SILENT_MS,
);
/** Berapa hari rekap durasi per proyek dihitung. */
const SUMMARY_DAYS = Number(process.env.SUMMARY_DAYS || DEFAULT_SUMMARY_DAYS);
/**
 * Berapa lama sesi `idle` masih ditampilkan.
 *
 * Dua nilai, karena dua hal berbeda: kartu "IDLE (tanpa task)" tidak memberi
 * informasi apa pun dan dibuang cepat, sedangkan sesi idle yang punya task
 * menyimpan riwayat pekerjaan yang baru selesai.
 */
const IDLE_TTL = process.env.IDLE_TTL || '30 minutes';
const EMPTY_IDLE_TTL = process.env.EMPTY_IDLE_TTL || '5 minutes';

const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 4 }) : null;

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Workflow Monitor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
         background:#0b0f14; color:#e6edf3; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#7d8590; font-size:12px; margin-bottom:16px; }
  .card { border:1px solid #21262d; border-radius:10px; padding:14px; margin-bottom:12px;
          background:#0f151c; }
  .card.live { border-color:#2f81f7; box-shadow:0 0 0 1px #2f81f755; }
  .card.stuck { border-color:#d2992255; box-shadow:0 0 0 1px #d2992233; }
  .card.ended { opacity:.62; }
  .phase.stuck { background:#d2992222; color:#e3b341; border-color:#d2992255; }
  .phase.ended { background:#6e768122; color:#8b949e; border-color:#6e768155; }
  .row { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .task { font-weight:600; }
  .meta { color:#7d8590; font-size:12px; }
  .phase { background:#1f6feb22; color:#79c0ff; border:1px solid #1f6feb55;
           border-radius:999px; padding:1px 9px; font-size:11px; text-transform:uppercase;
           letter-spacing:.4px; }
  .bar { height:6px; background:#21262d; border-radius:999px; overflow:hidden; margin:10px 0 4px; }
  .bar > i { display:block; height:100%; background:#2f81f7; }
  ul { list-style:none; margin:8px 0 0; padding:0; font-size:13px; }
  li { padding:2px 0; color:#9da7b3; }
  li.done { color:#3fb950; text-decoration:line-through; }
  .empty { color:#7d8590; text-align:center; padding:40px 0; }
  .events { font-size:12px; color:#7d8590; }
  .events b { color:#c9d1d9; font-weight:500; }
  .warn { border:1px solid #d2992255; background:#d299221a; color:#e3b341;
          border-radius:10px; padding:10px 12px; margin-bottom:12px; font-size:13px; }
  .warn b { color:#f0c674; }
  .btnrow { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .btn { background:#1f6feb22; color:#79c0ff; border:1px solid #1f6feb55; border-radius:8px;
         padding:5px 11px; font-size:12px; cursor:pointer; font-family:inherit; }
  .btn:hover { background:#1f6feb33; }
  .btn:active { transform:translateY(1px); }
  .btn:disabled { opacity:.55; cursor:default; }
  .btn.danger { background:#f851491a; color:#ff7b72; border-color:#f8514955; }
  .btn.danger:hover { background:#f8514928; }
  .salin { width:100%; background:#0b0f14; color:#e6edf3; border:1px solid #2f81f7;
           border-radius:8px; padding:7px 9px; font:12px/1.4 ui-monospace,monospace;
           margin-top:8px; }
</style></head><body>
<h1>Dev Workflow Monitor</h1>
<div class="sub" id="sub">menyambung…</div>
<div id="warn"></div>
<div id="alerts"></div>
<div id="list"><div class="empty">memuat…</div></div>
<h1 style="font-size:14px;margin-top:24px" id="summaryTitle">Waktu per proyek</h1>
<div id="summary" class="events"></div>
<h1 style="font-size:14px;margin-top:24px">Mesin terhubung</h1>
<div id="machines" class="events"></div>
<h1 style="font-size:14px;margin-top:24px">Selesai (7 hari)</h1>
<div id="history" class="events"></div>
<h1 style="font-size:14px;margin-top:24px">Aktivitas terakhir</h1>
<div id="events" class="events"></div>
<h1 style="font-size:14px;margin-top:24px">Tautan berbagi yang hidup</h1>
<div id="tautan" class="events">memuat...</div>
<script>
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ago(iso, nowMs) {
  if (!iso) return '';
  const d = ((nowMs || Date.now()) - new Date(iso).getTime()) / 1000;
  if (!isFinite(d) || d < 0) return 'baru saja';
  if (d < 60) return Math.round(d) + 'd lalu';
  if (d < 3600) return Math.round(d/60) + 'm lalu';
  if (d < 86400) return Math.round(d/3600) + 'j lalu';
  return Math.round(d/86400) + 'h lalu';
}

/**
 * Salin teks dengan empat lapis percobaan.
 *
 * MENGAPA EMPAT, BUKAN SATU
 * -------------------------
 * Dashboard ini dibuka lewat http://100.107.65.21:3100 - BUKAN secure
 * context. Di sana navigator.share tidak ada sama sekali, dan
 * navigator.clipboard.writeText ada tetapi DITOLAK. Tombol Bagikan yang
 * hanya memakai keduanya akan tampak berfungsi lalu gagal tanpa pesan.
 * Urutan di bawah menuruni lapisan sampai ada yang berhasil; bila semuanya
 * gagal, pemanggil menampilkan kotak teks tersorot.
 *
 * @returns {Promise<'share'|'clipboard'|'exec'|'manual'>}
 */
async function salinTeks(teks) {
  if (navigator.share) {
    try {
      await navigator.share({ url: teks, title: 'Status pekerjaan' });
      return 'share';
    } catch (e) {
      // Sheet ditutup pengguna, atau API ada tetapi menolak. Turun lapisan.
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(teks);
      return 'clipboard';
    } catch (e) { /* bukan secure context, atau izin ditolak */ }
  }
  try {
    var ta = document.createElement('textarea');
    ta.value = teks;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'exec';
  } catch (e) { /* execCommand dihapus di sebagian browser */ }
  return 'manual';
}

/** Kotak teks tersorot untuk disalin tangan - jalan terakhir, bukan gagal diam. */
function kotakSalinManual(url) {
  var id = 'salin-' + Math.random().toString(36).slice(2);
  setTimeout(function () {
    var el = document.getElementById(id);
    if (el) { el.focus(); el.select(); }
  }, 0);
  return '<textarea class="salin" id="' + id + '" readonly>' + esc(url) + '</textarea>';
}/** Panggil /api/share. Header penanda wajib; server menolak tanpa itu. */
async function mintaTautan(sessionKey) {
  var r = await fetch('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-devwf-share': '1' },
    body: JSON.stringify({ sessionKey: sessionKey })
  });
  var body = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(body.error || ('server menjawab ' + r.status));
  return body;
}

async function cabutTautan(token) {
  var r = await fetch('/api/share?token=' + encodeURIComponent(token), {
    method: 'DELETE',
    headers: { 'x-devwf-share': '1' }
  });
  var body = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(body.error || ('server menjawab ' + r.status));
  return body;
}

/**
 * Pesan sementara di dalam kartu, bukan alert().
 *
 * alert() memblokir seluruh halaman - termasuk polling 3 detik yang membuat
 * layar tablet tetap hidup dan jam "x lalu" tetap benar.
 */
function pesanKartu(tombol, teks) {
  var kartu = tombol.closest('.card');
  if (!kartu) return null;
  var lama = kartu.querySelector('.pesan-share');
  if (lama) lama.remove();
  var div = document.createElement('div');
  div.className = 'meta pesan-share';
  div.style.marginTop = '6px';
  div.textContent = teks;
  kartu.appendChild(div);
  return div;
}

async function tombolBagikan(sessionKey, tombol) {
  tombol.disabled = true;
  var asli = tombol.textContent;
  tombol.textContent = 'menyiapkan...';
  try {
    var hasil = await mintaTautan(sessionKey);
    var cara = await salinTeks(hasil.url);
    if (cara === 'manual') {
      pesanKartu(tombol, 'Tautan siap - salin manual:');
      // Kotak ditaruh di KARTU, bukan setelah tombol: .btnrow adalah flex row,
      // jadi textarea di dalamnya ikut aturan flex dan tampak janggal. Dan
      // hapus yang lama lebih dulu supaya klik ganda sebelum repaint tidak
      // menumpuk dua kotak.
      var kartu = tombol.closest('.card');
      if (kartu) {
        var lama = kartu.querySelector('textarea.salin');
        if (lama) lama.remove();
        kartu.insertAdjacentHTML('beforeend', kotakSalinManual(hasil.url));
      }
    } else {
      pesanKartu(tombol, 'Tautan disalin: ' + hasil.url);
    }
  } catch (e) {
    pesanKartu(tombol, 'Gagal membuat tautan: ' + e.message);
  } finally {
    tombol.disabled = false;
    tombol.textContent = asli;
    tick();
  }
}

async function tombolSalin(url, tombol) {
  tombol.disabled = true;
  try {
    var cara = await salinTeks(url);
    pesanKartu(tombol, cara === 'manual' ? 'Salin manual: ' + url : 'Tautan disalin.');
  } finally {
    tombol.disabled = false;
  }
}

async function tombolCabut(token, tombol) {
  tombol.disabled = true;
  try {
    var hasil = await cabutTautan(token);
    pesanKartu(tombol, hasil.revoked ? 'Tautan dicabut.' : 'Tautan sudah tidak aktif.');
  } catch (e) {
    pesanKartu(tombol, 'Gagal mencabut: ' + e.message);
  } finally {
    tombol.disabled = false;
    tick();
  }
}
function render(data) {
  // Jam SERVER: label umur tidak boleh bergantung pada jam perangkat.
  const jNow = data.now ? new Date(data.now).getTime() : Date.now();
  document.getElementById('sub').textContent =
    data.sessions.length + ' sesi · ' + new Date(jNow).toLocaleTimeString('id-ID');
  // Penanda "data masih hidup". Tanpa ini, monitor yang mati tampak persis
  // seperti monitor yang memang tidak ada pekerjaan - dan pemiliknya tidak
  // punya cara membedakannya.
  const h = data.health || {};
  const warn = document.getElementById('warn');
  if (h.stale) {
    warn.innerHTML = '<div class="warn"><b>⚠ Tidak ada laporan masuk</b><br>' +
      (h.never
        ? 'Belum pernah ada laporan sama sekali. Periksa DEVWF_MONITOR_URL dan token di mesin pengirim.'
        : 'Terakhir ' + ago(h.lastReportAt, jNow) + '. Bisa berarti tidak ada yang bekerja, ' +
          'atau pelaporannya terputus — periksa mesin atau service devwf-monitor.') +
      '</div>';
  } else {
    warn.innerHTML = '';
  }
  // Peringatan: bagian yang berbicara lebih dulu, bukan menunggu dilihat.
  //
  // Dihitung server dari baris yang SAMA dengan yang tampil, jadi angkanya
  // tidak bisa berbeda dengan isi layar. Kalau kosong, tidak ada yang
  // ditampilkan - peringatan yang selalu ada akan diabaikan.
  const al = data.alerts || [];
  const alBox = document.getElementById('alerts');
  if (al.length) {
    alBox.innerHTML = '<div class="warn"><b>' + al.length + ' hal perlu dilihat</b><br>' +
      al.slice(0, 6).map(a =>
        (a.kind === 'sesi_macet' ? '◆ ' : '● ') + esc(a.pesan)).join('<br>') +
      (al.length > 6 ? '<br>dan ' + (al.length - 6) + ' lagi' : '') +
      '<div class="meta" style="margin-top:6px">Disebut "mungkin macet" karena dari server ' +
      'tidak bisa dibedakan antara macet dan task yang sudah ditutup lalu ditinggal.</div>' +
      '</div>';
  } else {
    alBox.innerHTML = '';
  }
  const live = data.sessions.filter(s => s.state === 'live').length;
  const list = document.getElementById('list');
  if (!data.sessions.length) {
    list.innerHTML = '<div class="empty">belum ada sesi melapor</div>';
  } else {
    list.innerHTML = data.sessions.map(s => {
      const total = s.plan_total || 0, done = s.plan_done || 0;
      const pct = total ? Math.round(done/total*100) : 0;
      const plan = (s.plan_json || []).map(p =>
        '<li class="' + (p.status === 'done' ? 'done' : '') + '">' +
        (p.status === 'done' ? '✓ ' : '• ') + esc(p.text) + '</li>').join('');
      // Kelas kartu mengikuti STATUS, bukan phase: task yang selesai tanpa
      // menutup state-nya tidak boleh terus tampil sebagai pekerjaan hidup.
      const st = s.state || (s.phase === 'idle' ? 'idle' : 'live');
      const cardCls = st === 'live' ? 'live' : (st === 'possibly_stuck' ? 'stuck' : (st === 'ended' ? 'ended' : ''));
      const chipCls = st === 'possibly_stuck' ? 'phase stuck' : (st === 'ended' ? 'phase ended' : 'phase');
      const chipText = st === 'idle' ? esc(s.phase) : esc(s.state_label || st);
      const note = st === 'possibly_stuck'
        ? '<div class="meta">tidak ada kabar ' + ago(s.updated_at, jNow) + ' — mungkin berhenti di tengah jalan</div>'
        : (st === 'ended'
          ? '<div class="meta">berakhir ' + ago(s.updated_at, jNow) + ' — kemungkinan sudah selesai tanpa penutupan</div>'
          : '');
      /**
       * Tombol share per kartu.
       *
       * Diputuskan dari data SERVER (data.shares), bukan dari state lokal:
       * dua perangkat yang membuka dashboard yang sama harus melihat hal yang
       * sama, dan setelah menekan Share kartu digambar ulang dari tick().
       */
      const tautan = (data.shares || []).find(function (x) { return x.sessionKey === s.session_key; });
      const tombolShare = tautan
        ? '<div class="btnrow"><button class="btn" data-copy="' + esc(tautan.url) + '">Salin tautan</button>' +
          '<button class="btn danger" data-revoke="' + esc(tautan.token) + '">Cabut</button>' +
          '<span class="meta">dibuka ' + (tautan.views || 0) + '×</span></div>'
        : '<div class="btnrow"><button class="btn" data-share="' + esc(s.session_key) + '">Bagikan</button></div>';
      return '<div class="card ' + cardCls + '">' +
        '<div class="row"><span class="' + chipCls + '">' + chipText + '</span>' +
        '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' +
        esc(String(s.agent_tool || 'unknown').toUpperCase()) + '</span>' +
        '<span class="task">' + esc(s.task || '(tanpa task)') + '</span></div>' +
        note +
        '<div class="meta">' + esc(s.machine) + ' · ' + esc(s.project_name) +
        ' · ' + esc(s.task_type) + ' · ' + ago(s.updated_at, jNow) + '</div>' +
        (total ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="meta">rencana ' + done + '/' + total + ' · DoD ' + s.dod_done + '/' + s.dod_total +
          (s.dod_waived ? ' (' + s.dod_waived + ' dilewati)' : '') + '</div>' : '') +
        (plan ? '<ul>' + plan + '</ul>' : '') +
        tombolShare +
        '</div>';
    }).join('');
  }
  document.getElementById('summaryTitle').textContent =
    'Waktu per proyek · ' + (data.summary_days || 7) + ' hari (hanya yang sudah selesai)';
  document.getElementById('summary').innerHTML = (data.summary || []).map(r =>
    '<div><b style="color:#79c0ff">' + esc(r.total_label || '-') + '</b> ' + esc(r.project) +
    '<span class="meta"> · ' + r.sessions + ' sesi selesai · terakhir ' + ago(r.last_at, jNow) + '</span></div>'
  ).join('') || '<div>—</div>';
  document.getElementById('machines').innerHTML = (data.machines || []).map(m =>
    '<div><b style="color:' + (m.stale ? '#d29922' : '#3fb950') + '">' + (m.stale ? '⚠' : '●') + '</b> ' +
    esc(m.machine) + '<span class="meta"> · terakhir melapor ' + ago(m.last_seen, jNow) +
    (m.last_project ? ' · ' + esc(m.last_project) : '') +
    (m.stale ? ' · sudah lama tidak melapor' : '') + '</span></div>'
  ).join('') || '<div>—</div>';
  document.getElementById('history').innerHTML = (data.history || []).map(h =>
    '<div><b style="color:#c9d1d9">' + esc(h.task || h.session_title || h.project_name || '(tanpa nama)') + '</b>' +
    '<span class="meta"> · ' + esc(String(h.agent_tool || '').toUpperCase()) + ' · ' + esc(h.machine) +
    (h.project_name ? ' · ' + esc(h.project_name) : '') +
    (h.duration_label ? ' · ⏱ ' + esc(h.duration_label) : ' · durasi tidak tercatat') +
    ' · ' + ago(h.updated_at, jNow) + '</span></div>'
  ).join('') || '<div>—</div>';
  document.getElementById('events').innerHTML = (data.events || []).map(e =>
    '<div><b>' + esc(e.kind) + '</b> ' + esc(e.detail) +
    '<span class="meta"> · ' + esc(e.project_name) + ' · ' + ago(e.at, jNow) + '</span></div>').join('')
    || '<div>—</div>';
}
async function tick() {
  try {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    document.getElementById('sub').textContent = 'terputus: ' + e.message;
  }
}
/**
 * Panel "Tautan berbagi": SEMUA tautan hidup, termasuk yang sesinya sudah
 * hilang dari daftar kartu.
 *
 * MENGAPA PANEL INI ADA: tautan hidup sampai dicabut, sementara kartu sesi
 * hilang setelah 30 menit idle. Tanpa panel ini, tautan yang sudah tersebar
 * ke WhatsApp tidak punya jalan mencabutnya - celah yang justru berbahaya
 * karena tidak terlihat.
 */
async function muatTautan() {
  var box = document.getElementById('tautan');
  try {
    var r = await fetch('/api/share?all=1', { headers: { 'x-devwf-share': '1' } });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || ('server menjawab ' + r.status));
    var daftar = data.shares || [];
    if (!daftar.length) {
      box.innerHTML = '<div>tidak ada tautan yang hidup</div>';
      return;
    }
    var yatim = data.orphanCount || 0;
    var kepala = '<div style="margin-bottom:8px">' + daftar.length + ' tautan hidup' +
      (yatim
        ? ' · <b style="color:#d29922">' + yatim + ' tautannya tidak punya sesi lagi</b> ' +
          '<button class="btn danger" data-revoke-orphans="1">Cabut yang yatim</button>'
        : '') +
      '</div>';
    box.innerHTML = kepala + daftar.map(function (s) {
      var catatan = s.sessionGone
        ? '<span class="meta" style="color:#d29922">sesinya sudah tidak tampil</span>'
        : '<span class="meta">' + esc(s.phase || '') + '</span>';
      return '<div style="margin:4px 0"><b style="color:#c9d1d9">' + esc(s.label) + '</b> ' +
        catatan +
        '<span class="meta"> · dibuka ' + (s.views || 0) + 'x · ' + ago(s.createdAt, Date.now()) + '</span>' +
        '<div class="btnrow">' +
        '<button class="btn" data-copy="' + esc(s.url) + '">Salin</button>' +
        '<button class="btn danger" data-revoke="' + esc(s.token) + '">Cabut</button>' +
        '</div></div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div style="color:#ff7b72">gagal memuat tautan: ' + esc(e.message) + '</div>';
  }
}

/**
 * Cabut semua tautan yatim sekaligus.
 *
 * Tanpa konfirmasi karena aksinya sempit: hanya tautan yang baris sesinya
 * sudah tidak ada. Tautan yang masih punya sesi - termasuk yang baru hilang
 * dari layar karena idle - tidak tersentuh.
 */
async function cabutYatim(tombol) {
  tombol.disabled = true;
  tombol.textContent = 'mencabut...';
  try {
    var r = await fetch('/api/share?revoke-orphans=1', {
      method: 'POST',
      headers: { 'x-devwf-share': '1' }
    });
    var body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || ('server menjawab ' + r.status));
    await muatTautan();
  } catch (e) {
    tombol.disabled = false;
    tombol.textContent = 'Cabut yang yatim';
    alert('Gagal mencabut: ' + e.message);
  }
}

/**
 * Satu listener untuk seluruh daftar kartu.
 *
 * Delegasi, bukan listener per tombol: kartu digambar ulang setiap 3 detik,
 * jadi listener yang dipasang saat render akan hilang bersama elemennya dan
 * tombolnya berhenti bekerja tanpa ada yang menyadarinya.
 */
document.getElementById('list').addEventListener('click', function (e) {
  var t = e.target.closest('[data-share],[data-copy],[data-revoke]');
  if (!t) return;
  if (t.dataset.share) { void tombolBagikan(t.dataset.share, t); }
  else if (t.dataset.copy) { void tombolSalin(t.dataset.copy, t); }
  else if (t.dataset.revoke) { void tombolCabut(t.dataset.revoke, t); }
});
// Panel tautan memakai listener yang sama; tombolnya hidup di luar #list.
document.getElementById('tautan').addEventListener('click', function (e) {
  var t = e.target.closest('[data-copy],[data-revoke],[data-revoke-orphans]');
  if (!t) return;
  if (t.dataset.revokeOrphans) { void cabutYatim(t); }
  else if (t.dataset.copy) { void tombolSalin(t.dataset.copy, t); }
  else if (t.dataset.revoke) { void tombolCabut(t.dataset.revoke, t); }
});
/**
 * Panel tautan disegarkan lebih jarang daripada kartu.
 *
 * Kartu perlu 3 detik karena menampilkan pekerjaan yang sedang berjalan;
 * daftar tautan berubah hanya saat seseorang menekan Bagikan atau Cabut.
 * Menyegarkannya tiap 3 detik berarti satu query tambahan setiap 3 detik
 * untuk data yang hampir tidak pernah berubah.
 */
tick(); muatTautan();
setInterval(tick, ${POLL_MS});
setInterval(muatTautan, 30000);
</script></body></html>`;

async function query(sql, params) {
  if (!pool) throw new Error('DATABASE_URL not set');
  return pool.query(sql, params);
}

function readBody(req, limit = 256 * 1024) {  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const str = (v, max = 4000) => String(v == null ? '' : v).slice(0, max);

/**
 * Parse JSON dengan jawaban 400, bukan 500.
 *
 * `JSON.parse` yang melempar akan jatuh ke catch teratas dan mengirim
 * `error.message` dari V8 ke pengirim. Pesan itu tidak membantu siapa pun dan
 * sedikit membocorkan bentuk internal. Mengembalikan `null` menandakan
 * "sudah dijawab" supaya pemanggil berhenti.
 */
function bacaJson(mentah, res) {
  try {
    return JSON.parse(mentah || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'body bukan JSON yang sah' }));
    return null;
  }
}

/**
 * Tolak penulisan tanpa token yang benar.
 *
 * Pesannya sengaja menyebut penyebab yang paling sering terjadi - token belum
 * diisi di environment mesin pengirim - supaya kegagalan ini tidak berakhir
 * sebagai "dashboard tidak pernah update" yang misterius.
 */
function denyWrite(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({
    ok: false,
    error: 'unauthorized',
    hint: WRITE_TOKEN
      ? 'Kirim header Authorization: Bearer <DEVWF_MONITOR_TOKEN>.'
      : 'Server ini belum punya DEVWF_MONITOR_TOKEN, jadi semua penulisan ditolak.',
  }));
}

/**
 * Terima token SEKARANG, atau token LAMA selama masa rotasi.
 *
 * Dicek dengan `isWriteAuthorized` yang sama, jadi aturan "kosong berarti
 * tolak" tetap berlaku untuk keduanya.
 */
function writeAllowed(req) {
  const header = req.headers.authorization;
  if (isWriteAuthorized({ header, expectedToken: WRITE_TOKEN })) return true;
  if (!WRITE_TOKEN_PREVIOUS) return false;
  return isWriteAuthorized({ header, expectedToken: WRITE_TOKEN_PREVIOUS });
}

/** Buang baris lama supaya tabel tidak tumbuh selamanya. Hanya bila DIMINTA. */
async function pruneOldRows() {
  if (!PRUNE_ON) return;
  try {
    const events = buildPruneEventsQuery({ retentionDays: RETENTION_DAYS });
    const sessions = buildPruneSessionsQuery({ sessionRetentionDays: SESSION_RETENTION_DAYS });
    const a = await query(events.sql, events.params);
    const b = await query(sessions.sql, sessions.params);
    if (a.rowCount || b.rowCount) {
      console.log(`prune: ${a.rowCount} events, ${b.rowCount} idle sessions`);
    }
  } catch (error) {
    // Pembersihan yang gagal tidak boleh menghentikan dashboard.
    console.error('prune gagal:', String(error && error.message || error));
  }
}

async function upsertSession(body) {
  const { sql, params } = buildSessionUpsert(body);
  await query(sql, params);
  return str(body.sessionKey, 200);
}

async function insertEvent(body) {
  const kind = str(body.kind, 80);
  if (!kind) throw new Error('kind wajib');
  await query(
    `INSERT INTO events (session_key, machine, project_name, kind, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [str(body.sessionKey, 200), str(body.machine, 120), str(body.projectName, 160),
     kind, str(body.detail, 1000)]);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    }
    if (url.pathname === '/api/share') {
      /**
       * Penjaga dijalankan SEBELUM apa pun yang lain.
       *
       * Bukan autentikasi penuh - port ini hanya terjangkau dari tailnet -
       * tetapi tanpa ini halaman web lain yang dibuka di browser pemilik bisa
       * membuat tautan atas namanya.
       */
      const izin = shareGuard({ headers: req.headers, allowedOrigins: SHARE_ORIGINS, method: req.method });
      if (!izin.ok) {
        res.writeHead(izin.status || 403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false,
          error: izin.error || 'forbidden',
          hint: 'Kirim header X-Devwf-Share: 1 dari origin dashboard.',
        }));
      }
      /**
       * Preflight dari origin yang SAH dijawab 204 dengan header CORS.
       *
       * Hanya untuk origin yang lolos guard, jadi ini tidak membuka pintu:
       * halaman asing tetap ditolak 403 sebelum sampai ke sini. Menjawab 405
       * seperti sebelumnya berarti satu-satunya yang menahan tulisan
       * lintas-situs adalah ketiadaan header CORS - kebetulan, bukan aturan.
       */
      if (izin.preflight) {
        res.writeHead(204, {
          'access-control-allow-origin': String(req.headers.origin),
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-devwf-share',
          'access-control-max-age': '600',
          vary: 'origin',
        });
        return res.end();
      }

      if (req.method === 'POST' && url.searchParams.get('revoke-orphans')) {
        const hasil = await revokeOrphanShares({ query });
        res.writeHead(hasil.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(hasil.body));
      }
      if (req.method === 'POST') {
        /**
         * Body yang bukan JSON dijawab 400, bukan 500.
         *
         * JSON.parse yang melempar akan jatuh ke catch teratas dan mengirim
         * `error.message` dari V8 ke pemanggil - pesan parser yang tidak
         * berguna bagi pemilik dan sedikit membocorkan bentuk internal.
         */
        const body = bacaJson(await readBody(req), res);
        if (body === null) return undefined;        const hasil = await handleCreateShare({ query, sessionKey: body && body.sessionKey });
        res.writeHead(hasil.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(hasil.body));
      }
      if (req.method === 'DELETE') {
        const hasil = await handleRevokeShare({ query, token: url.searchParams.get('token') });
        res.writeHead(hasil.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(hasil.body));
      }
      if (req.method === 'GET') {
        /**
         * `?all=1` = panel "Tautan berbagi": SEMUA tautan hidup, termasuk
         * yang sesinya sudah hilang dari layar. Tanpa ini tautan bisa hidup
         * selamanya tanpa jalan mencabutnya.
         */
        if (url.searchParams.get('all')) {
          const hasil = await handleListAllShares({ query });
          res.writeHead(hasil.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify(hasil.body));
        }
        const hasil = await handleListShares({ query, sessionKey: url.searchParams.get('sessionKey') });
        res.writeHead(hasil.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(hasil.body));
      }
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST, DELETE' });
      return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (!writeAllowed(req)) {
        return denyWrite(res);
      }
      // Body bukan JSON dijawab 400, bukan 500: pesan parser V8 tidak berguna
      // bagi pengirim, dan menyebutkannya membocorkan bentuk internal.
      const body = bacaJson(await readBody(req), res);
      if (body === null) return undefined;
      const key = await upsertSession(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessionKey: key }));
    }
    if (url.pathname === '/api/event' && req.method === 'POST') {
      if (!writeAllowed(req)) {
        return denyWrite(res);
      }
      const body = bacaJson(await readBody(req), res);
      if (body === null) return undefined;
      await insertEvent(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/sessions') {
      const limit = Math.min(50, Number(url.searchParams.get('limit') || 20));
      // Sesi `idle` yang sudah lama tidak melapor disembunyikan: proses MCP
      // mati bersama sesi OpenCode-nya, jadi barisnya tinggal sebagai sampah
      // dan memenuhi layar tablet. Sesi yang masih bekerja TIDAK pernah
      // disembunyikan, seberapa lama pun ia berjalan tanpa menyimpan state.
      const { sql, params } = buildSessionsQuery({ limit, idleTtl: IDLE_TTL, emptyIdleTtl: EMPTY_IDLE_TTL });
      const sessions = await query(sql, params);
      const events = await query(
        `SELECT at, kind, detail, project_name, machine
           FROM events ORDER BY at DESC LIMIT 15`);
      // Kapan laporan terakhir masuk? Diambil dari kedua tabel supaya satu
      // laporan pun (sesi atau event) cukup untuk membuktikan jalur hidup.
      const last = await query(
        `SELECT GREATEST(
                  (SELECT max(updated_at) FROM sessions),
                  (SELECT max(at) FROM events)
                ) AS last_report_at`);
      const health = buildHealth({
        lastReportAt: last.rows[0] ? last.rows[0].last_report_at : null,
        staleAfterMs: STALE_AFTER_MS,
      });
      // Daftar MESIN, terpisah dari daftar sesi.
      //
      // Tanpa ini, mesin yang menganggur hilang dari layar dan "tidak ada
      // pekerjaan" tampak sama dengan "mesin tidak pernah terhubung".
      const mq = buildMachinesQuery({ staleAfterDays: STALE_AFTER_DAYS });
      const machineRows = await query(mq.sql, mq.params);
      // Riwayat sesi SELESAI. Durasi dihitung database supaya sama di semua
      // perangkat, dan tidak ada data yang dihapus.
      const hq = buildHistoryQuery({ historyDays: HISTORY_DAYS });
      // Waktu acuan untuk menurunkan status, dipakai kartu aktif DAN riwayat.
      const nowMs = Date.now();
      const historyRows = await query(hq.sql, hq.params);
      const history = historyRows.rows.map((r) => {
        // Status memakai fungsi yang SAMA dengan kartu aktif, supaya riwayat
        // dan kartu tidak pernah berbeda pendapat soal sesi yang sama.
        const st = classifySession({
          phase: r.phase,
          updatedAt: r.updated_at,
          now: nowMs,
          liveMs: LIVE_MS,
          stuckMs: STUCK_MS,
        });
        return {
          ...r,
          duration_label: formatDuration(r.duration_seconds),
          state: st.status,
          state_label: LABELS[st.status] || st.status,
        };
      });
      // Waktu acuan SERVER, dikirim ke klien.
      //
      // MENGAPA: aplikasi menghitung "4m lalu" dari jam PERANGKAT. Kalau jam
      // tablet atau emulator meleset - dan emulator MuMu terbukti bisa
      // menampilkan tanggal yang jauh berbeda - semua label umur jadi salah
      // tanpa ada yang tahu sebabnya. Klien kini memakai `now` ini, bukan
      // jamnya sendiri.
      const serverNow = new Date().toISOString();
      // Status diturunkan dari umur laporan, bukan diklaim dari `phase`.
      // Task yang selesai tanpa mengubah phase menjadi idle akan tampak
      // "mungkin macet" atau "berakhir", bukan "aktif" selamanya.
      const rows = sessions.rows.map((row) => {
        const s = classifySession({
          phase: row.phase,
          updatedAt: row.updated_at,
          now: nowMs,
          liveMs: LIVE_MS,
          stuckMs: STUCK_MS,
        });
        return { ...row, state: s.status, state_label: LABELS[s.status] || s.status };
      });
      // Buang kartu kembar (mesin + task sama) sebelum dikirim ke layar.
      const tampil = dedupeSessions(rows);
      // Rekap durasi per proyek. Hanya sesi yang SUDAH DITUTUP, karena durasi
      // sesi berjalan masih bertambah dan tidak bisa dibandingkan antar hari.
      const sq = buildProjectSummaryQuery({ days: SUMMARY_DAYS });
      const summaryRows = await query(sq.sql, sq.params);
      const summary = summaryRows.rows.map((r) => ({
        ...r,
        total_label: formatDurationSummary(r.total_seconds),
      }));
      // Peringatan: satu-satunya bagian dashboard yang berbicara lebih dulu.
      // Dihitung dari baris yang SUDAH ditampilkan, jadi angkanya tidak bisa
      // berbeda dengan yang dilihat pemilik di layar.
      const alerts = buildAlerts({
        sessions: tampil,
        machines: machineRows.rows,
        now: nowMs,
        stuckAlertMs: STUCK_ALERT_MS,
        machineSilentMs: MACHINE_SILENT_MS,
      });
      /**
       * Tautan share yang sedang hidup, untuk tombol di kartu.
       *
       * DI TRY SENDIRI: tabel `share_links` baru dibuat sesudah deploy, dan
       * dashboard yang sudah berjalan harus tetap menampilkan sesi walau
       * tabelnya belum ada. Kegagalan di sini tidak boleh menghapus seluruh
       * layar tablet.
       */
      let shares = [];
      try {
        shares = await listLiveShares({ query });
      } catch (error) {
        console.error('daftar share gagal:', String((error && error.message) || error));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({ now: serverNow, sessions: tampil, events: events.rows, health, machines: machineRows.rows, history, alerts, summary, shares, summary_days: SUMMARY_DAYS }),
      );
    }
    if (url.pathname === '/api/events') {
      const rows = await query(
        `SELECT at, session_key, machine, project_name, kind, detail
           FROM events ORDER BY at DESC LIMIT $1`,
        [Math.min(200, Number(url.searchParams.get('limit') || 50))]);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(rows.rows));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error && error.message || error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`devwf-monitor listening on ${HOST}:${PORT}`);
  if (!WRITE_TOKEN) {
    console.warn('PERINGATAN: DEVWF_MONITOR_TOKEN kosong - semua penulisan ditolak.');
  }
  // Tabel tautan share disiapkan di sini, TIDAK ditunggu dan TIDAK boleh
  // menggagalkan boot: dashboard harus tetap menyala walau user database tidak
  // punya hak CREATE. Bila gagal, SQL-nya dicetak supaya operator bisa
  // menjalankannya sendiri.
  void (async () => {
    try {
      await query(ensureTableSql);
    } catch (error) {
      console.error('GAGAL menyiapkan tabel share_links:', String((error && error.message) || error));
      console.error('Jalankan sekali sebagai user database aplikasi:\n' + ensureTableSql);
    }
  })();
  // Penghapusan otomatis MATI kecuali PRUNE_ENABLED diisi eksplisit.
  if (!PRUNE_ON) {
    console.log('retensi: MATI (set PRUNE_ENABLED=1 untuk menyalakan). Tidak ada data yang dihapus.');
    return;
  }
  console.log(`retensi: AKTIF - events > ${RETENTION_DAYS} hari, sesi idle > ${SESSION_RETENTION_DAYS} hari.`);
  void pruneOldRows();
  const timer = setInterval(() => void pruneOldRows(), PRUNE_EVERY_MS);
  if (typeof timer.unref === 'function') timer.unref();
});



