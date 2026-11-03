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
         background:#0b0f14; color:#e6edf3; padding:16px 16px 76px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#7d8590; font-size:12px; margin-bottom:16px; }
  .card { border:1px solid #21262d; border-radius:10px; padding:14px; margin-bottom:12px;
          background:#0f151c; }
  .card.live { border-color:#2f81f7; box-shadow:0 0 0 1px #2f81f755; }
  .card.stuck { border-color:#d2992255; box-shadow:0 0 0 1px #d2992233; }
  .card.ended { opacity:.62; }
  .clickable-card { cursor:pointer; transition:border-color .15s, background-color .15s; }
  .clickable-card:hover { border-color:#58a6ff88; background:#131a24; }
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
  .detail-hint { margin-top:8px; font-size:11px; color:#58a6ff; text-align:right; }

  /* Tab Navigation */
  .tabbar {
    position: fixed; bottom: 0; left: 0; right: 0; height: 56px;
    background: #0d1117; border-top: 1px solid #21262d;
    display: flex; z-index: 100;
  }
  .tab-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: transparent; border: none; color: #7d8590; font-size: 11px;
    cursor: pointer; padding: 6px 0; font-family: inherit; transition: color .15s;
  }
  .tab-btn:hover { color: #c9d1d9; }
  .tab-btn.active { color: #58a6ff; font-weight: 600; }
  .tab-icon { font-size: 18px; line-height: 1.2; margin-bottom: 2px; }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }

  /* Filter chips */
  .filter-row { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .filter-chip {
    background: #161b22; border: 1px solid #30363d; border-radius: 999px;
    color: #7d8590; padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .filter-chip.active { background: #1f6feb22; color: #58a6ff; border-color: #1f6feb; font-weight: 600; }

  /* Modal Detail */
  .modal {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .modal-backdrop {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75);
  }
  .modal-box {
    position: relative; z-index: 1; background: #0f151c; border: 1px solid #30363d;
    border-radius: 12px; max-width: 600px; width: 100%; max-height: 85vh;
    display: flex; flex-direction: column; box-shadow: 0 12px 36px rgba(0,0,0,0.6);
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 16px; border-bottom: 1px solid #21262d;
  }
  .modal-close {
    background: transparent; border: none; color: #7d8590; font-size: 20px;
    cursor: pointer; padding: 2px 8px; line-height: 1;
  }
  .modal-close:hover { color: #e6edf3; }
  .modal-body { padding: 16px; overflow-y: auto; }
  .modal-footer {
    padding: 12px 16px; border-top: 1px solid #21262d;
    display: flex; gap: 8px; justify-content: flex-end; align-items: center;
  }
  .modal-task { font-size: 16px; font-weight: 700; color: #e6edf3; margin-bottom: 4px; }
  .modal-session-title { color: #79c0ff; font-size: 13px; margin-bottom: 4px; }
  .modal-project { color: #2f81f7; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  .modal-sec-title { font-weight: 600; font-size: 13px; color: #d2a8ff; margin: 14px 0 6px; }
  .timer-badge { display: inline-block; background: #1f6feb22; color: #79c0ff; padding: 2px 8px; border-radius: 6px; font-size: 12px; margin-top: 6px; }
</style></head><body>
<h1>Dev Workflow Monitor</h1>
<div class="sub" id="sub">menyambung…</div>

<!-- TAB 1: AKTIF -->
<div id="tab-aktif" class="tab-pane active">
  <div id="warn"></div>
  <div id="alerts"></div>
  <div id="list"><div class="empty">memuat…</div></div>
  <h1 style="font-size:14px;margin-top:24px">Aktivitas terakhir</h1>
  <div id="events" class="events"></div>
</div>

<!-- TAB 2: RIWAYAT -->
<div id="tab-riwayat" class="tab-pane">
  <h1 style="font-size:14px;margin-bottom:12px">Selesai (7 hari)</h1>
  <div class="filter-row" id="history-filters">
    <button class="filter-chip active" data-filter="semua">Semua</button>
    <button class="filter-chip" data-filter="selesai">Selesai</button>
    <button class="filter-chip" data-filter="live">Live</button>
    <button class="filter-chip" data-filter="stuck">Macet</button>
  </div>
  <div id="history" class="events"></div>
</div>

<!-- TAB 3: REKAP -->
<div id="tab-rekap" class="tab-pane">
  <h1 style="font-size:14px;margin-bottom:12px" id="summaryTitle">Waktu per proyek</h1>
  <div id="summary" class="events"></div>
</div>

<!-- TAB 4: MESIN -->
<div id="tab-mesin" class="tab-pane">
  <h1 style="font-size:14px;margin-bottom:12px">Mesin terhubung</h1>
  <div id="machines" class="events"></div>
</div>

<!-- TAB 5: INFO -->
<div id="tab-info" class="tab-pane">
  <div class="card">
    <div style="font-weight:600;margin-bottom:6px">Tentang</div>
    <div class="meta" style="line-height:1.6">
      Dashboard sesi dev-workflow dari semua mesin.<br>
      Membaca tanpa login; penulisan wajib token.<br>
      Data tidak pernah dihapus otomatis.
    </div>
  </div>
  <div class="card">
    <div style="font-weight:600;margin-bottom:6px">Server</div>
    <div class="meta" id="serverInfo" style="line-height:1.6">
      Diperbarui otomatis tiap beberapa detik
    </div>
  </div>
  <h1 style="font-size:14px;margin-top:24px">Tautan berbagi yang hidup</h1>
  <div id="tautan" class="events">memuat...</div>
</div>

<!-- BOTTOM NAVIGATION BAR -->
<nav class="tabbar">
  <button class="tab-btn active" data-tab="aktif"><span class="tab-icon">▦</span><span class="tab-lbl">Aktif</span></button>
  <button class="tab-btn" data-tab="riwayat"><span class="tab-icon">☰</span><span class="tab-lbl">Riwayat</span></button>
  <button class="tab-btn" data-tab="rekap"><span class="tab-icon">Σ</span><span class="tab-lbl">Rekap</span></button>
  <button class="tab-btn" data-tab="mesin"><span class="tab-icon">▣</span><span class="tab-lbl">Mesin</span></button>
  <button class="tab-btn" data-tab="info"><span class="tab-icon">ⓘ</span><span class="tab-lbl">Info</span></button>
</nav>

<!-- MODAL DETAIL SESI -->
<div id="modal-detail" class="modal" style="display:none">
  <div class="modal-backdrop"></div>
  <div class="modal-box">
    <div class="modal-header">
      <div class="row" id="modal-chips"></div>
      <button class="modal-close" id="modal-close-btn">&times;</button>
    </div>
    <div class="modal-body">
      <div class="modal-task" id="modal-task"></div>
      <div class="modal-session-title" id="modal-session-title"></div>
      <div class="modal-project" id="modal-project"></div>
      <div class="meta" id="modal-meta"></div>
      <div class="meta" id="modal-path" style="word-break:break-all;margin-top:4px"></div>
      <div id="modal-timer"></div>
      <div id="modal-plan"></div>
      <div id="modal-dod"></div>
      <div id="modal-tech" class="events" style="margin-top:16px"></div>
    </div>
    <div class="modal-footer">
      <div id="modal-share-slot" style="flex:1"></div>
      <button class="btn" id="modal-tutup-btn">Tutup</button>
      <button class="btn danger" id="modal-close-session-btn" style="display:none">✕ Tutup Sesi</button>
    </div>
  </div>
</div>

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
function durasi(isoMulai, msSekarang) {
  if (!isoMulai) return '';
  const d = ((msSekarang || Date.now()) - new Date(isoMulai).getTime()) / 1000;
  if (!isFinite(d) || d < 0) return '';
  const m = Math.floor(d / 60);
  const j = Math.floor(m / 60);
  const sisaM = m % 60;
  if (j > 0) return j + 'j ' + (sisaM < 10 ? '0' : '') + sisaM + 'm';
  return m + 'm';
}

let lastData = null;
let currentTab = 'aktif';
let currentFilter = 'semua';
let activeDetailKey = null;

function pilihTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + tabId);
  });
}

function pilihFilter(filterId) {
  currentFilter = filterId;
  document.querySelectorAll('.filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === filterId);
  });
  if (lastData) renderHistory(lastData);
}

function bukaDetail(sessionKey) {
  if (!lastData) return;
  const s = (lastData.sessions || []).find(x => x.session_key === sessionKey) ||
            (lastData.history || []).find(x => x.session_key === sessionKey);
  if (!s) return;
  activeDetailKey = sessionKey;

  const jNow = lastData.now ? new Date(lastData.now).getTime() : Date.now();
  const st = s.state || (s.phase === 'idle' ? 'idle' : 'live');
  const chipCls = st === 'possibly_stuck' ? 'phase stuck' : (st === 'ended' ? 'phase ended' : 'phase');
  const chipText = st === 'idle' ? esc(s.phase) : esc(s.state_label || st);
  const agentText = esc(String(s.agent_tool || 'unknown').toUpperCase());

  document.getElementById('modal-chips').innerHTML =
    '<span class="' + chipCls + '">' + chipText + '</span>' +
    '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' + agentText + '</span>';

  document.getElementById('modal-task').textContent = s.task || '(tanpa task)';
  document.getElementById('modal-session-title').textContent = s.session_title ? '💬 ' + s.session_title : '';
  document.getElementById('modal-project').textContent = s.project_name || '';
  document.getElementById('modal-meta').textContent =
    esc(s.machine) + (s.task_type ? ' · ' + s.task_type : '') + ' · ' + ago(s.updated_at, jNow);
  document.getElementById('modal-path').textContent = s.project_path || '';

  const t = durasi(s.started_at, jNow);
  const timerEl = document.getElementById('modal-timer');
  if (t) {
    timerEl.innerHTML = '<span class="timer-badge">⏱ berjalan ' + esc(t) + '</span>';
  } else {
    timerEl.innerHTML = '';
  }

  // Plan
  const planEl = document.getElementById('modal-plan');
  const total = s.plan_total || 0, done = s.plan_done || 0;
  const pct = total ? Math.round(done/total*100) : 0;
  const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
  if (total > 0 || rencana.length > 0) {
    const planItems = rencana.map(p =>
      '<li class="' + (p.status === 'done' ? 'done' : '') + '">' +
      (p.status === 'done' ? '✓ ' : '• ') + esc(p.text) + '</li>').join('');
    planEl.innerHTML =
      '<div class="modal-sec-title">Rencana ' + done + '/' + total + ' (' + pct + '%)</div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<ul>' + planItems + '</ul>';
  } else {
    planEl.innerHTML = '<div class="modal-sec-title">Rencana</div><div class="meta">(belum ada rencana)</div>';
  }

  // DoD
  const dodEl = document.getElementById('modal-dod');
  const dodTotal = s.dod_total || 0, dodDone = s.dod_done || 0;
  const dodWaived = s.dod_waived ? ' (' + s.dod_waived + ' dilewati)' : '';
  dodEl.innerHTML =
    '<div class="modal-sec-title">Definition of Done ' + dodDone + '/' + dodTotal + dodWaived + '</div>' +
    (dodTotal === 0 ? '<div class="meta">(belum ada item DoD)</div>' : '');

  // Tech details
  document.getElementById('modal-tech').innerHTML =
    '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #21262d">' +
    '<div><b>kunci:</b> ' + esc(s.session_key) + '</div>' +
    '<div><b>fase:</b> ' + esc(s.phase || 'idle') + '</div>' +
    '<div><b>status:</b> ' + esc(s.state_label || s.state || '-') + '</div>' +
    '<div><b>alat:</b> ' + agentText + '</div>' +
    '<div><b>terakhir melapor:</b> ' + ago(s.updated_at, jNow) + '</div>' +
    '</div>';

  // Share slot
  const tautan = (lastData.shares || []).find(x => x.sessionKey === s.session_key);
  const shareSlot = document.getElementById('modal-share-slot');
  if (tautan) {
    shareSlot.innerHTML =
      '<div class="btnrow"><button class="btn" data-copy="' + esc(tautan.url) + '">Salin tautan</button>' +
      '<button class="btn danger" data-revoke="' + esc(tautan.token) + '">Cabut</button></div>';
  } else {
    shareSlot.innerHTML = '<button class="btn" data-share="' + esc(s.session_key) + '">Bagikan</button>';
  }

  document.getElementById('modal-detail').style.display = 'flex';

  // Tampilkan tombol "Tutup Sesi" hanya untuk sesi yang masih bisa ditutup
  var closeBtn = document.getElementById('modal-close-session-btn');
  if (closeBtn) {
    var isCloseable = st === 'live' || st === 'possibly_stuck' ||
      (s.phase && s.phase !== 'idle' && s.phase !== 'closed' &&
       s.phase !== 'done' && s.phase !== 'cancelled');
    closeBtn.style.display = isCloseable ? '' : 'none';
    closeBtn.dataset.sessionKey = s.session_key;
  }
}

function tutupModal() {
  document.getElementById('modal-detail').style.display = 'none';
  activeDetailKey = null;
}

/**
 * Salin teks dengan empat lapis percobaan.
 */
async function salinTeks(teks) {
  if (navigator.share) {
    try {
      await navigator.share({ url: teks, title: 'Status pekerjaan' });
      return 'share';
    } catch (e) {}
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(teks);
      return 'clipboard';
    } catch (e) {}
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
  } catch (e) {}
  return 'manual';
}

function kotakSalinManual(url) {
  var id = 'salin-' + Math.random().toString(36).slice(2);
  setTimeout(function () {
    var el = document.getElementById(id);
    if (el) { el.focus(); el.select(); }
  }, 0);
  return '<textarea class="salin" id="' + id + '" readonly>' + esc(url) + '</textarea>';
}

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

function pesanKartu(tombol, teks) {
  var kartu = tombol.closest('.card, .modal-box');
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
      var kartu = tombol.closest('.card, .modal-box');
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

function renderHistory(data) {
  const jNow = data.now ? new Date(data.now).getTime() : Date.now();
  let list = data.history || [];
  if (currentFilter === 'selesai') {
    list = list.filter(h => h.phase === 'idle' || h.state === 'ended');
  } else if (currentFilter === 'live') {
    list = list.filter(h => h.state === 'live');
  } else if (currentFilter === 'stuck') {
    list = list.filter(h => h.state === 'possibly_stuck');
  }

  const el = document.getElementById('history');
  if (!list.length) {
    el.innerHTML = '<div class="empty">tidak ada sesi dalam filter ini</div>';
    return;
  }

  el.innerHTML = list.map(h => {
    return '<div class="card clickable-card" data-session-key="' + esc(h.session_key) + '">' +
      '<div class="row">' +
      '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' +
      esc(String(h.agent_tool || 'unknown').toUpperCase()) + '</span>' +
      '<span class="task">' + esc(h.task || h.session_title || '(tanpa task)') + '</span></div>' +
      '<div class="meta" style="margin-top:4px">' + esc(h.machine) +
      (h.project_name ? ' · ' + esc(h.project_name) : '') +
      (h.duration_label ? ' · ⏱ ' + esc(h.duration_label) : ' · durasi tidak tercatat') +
      ' · ' + ago(h.updated_at, jNow) + '</div>' +
      '<div class="detail-hint">ketuk untuk detail ›</div>' +
      '</div>';
  }).join('');
}

function render(data) {
  lastData = data;
  const jNow = data.now ? new Date(data.now).getTime() : Date.now();
  document.getElementById('sub').textContent =
    data.sessions.length + ' sesi · ' + new Date(jNow).toLocaleTimeString('id-ID');

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

  const list = document.getElementById('list');
  if (!data.sessions.length) {
    list.innerHTML = '<div class="empty">belum ada sesi melapor</div>';
  } else {
    list.innerHTML = data.sessions.map(s => {
      const total = s.plan_total || 0, done = s.plan_done || 0;
      const pct = total ? Math.round(done/total*100) : 0;
      const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
      const plan = rencana.slice(0, 2).map(p =>
        '<li class="' + (p.status === 'done' ? 'done' : '') + '">' +
        (p.status === 'done' ? '✓ ' : '• ') + esc(p.text) + '</li>').join('');
      const st = s.state || (s.phase === 'idle' ? 'idle' : 'live');
      const cardCls = st === 'live' ? 'live' : (st === 'possibly_stuck' ? 'stuck' : (st === 'ended' ? 'ended' : ''));
      const chipCls = st === 'possibly_stuck' ? 'phase stuck' : (st === 'ended' ? 'phase ended' : 'phase');
      const chipText = st === 'idle' ? esc(s.phase) : esc(s.state_label || st);
      const note = st === 'possibly_stuck'
        ? '<div class="meta">tidak ada kabar ' + ago(s.updated_at, jNow) + ' — mungkin berhenti di tengah jalan</div>'
        : (st === 'ended'
          ? '<div class="meta">berakhir ' + ago(s.updated_at, jNow) + ' — kemungkinan sudah selesai tanpa penutupan</div>'
          : '');

      const tautan = (data.shares || []).find(x => x.sessionKey === s.session_key);
      const tombolShare = tautan
        ? '<div class="btnrow"><button class="btn" data-copy="' + esc(tautan.url) + '">Salin tautan</button>' +
          '<button class="btn danger" data-revoke="' + esc(tautan.token) + '">Cabut</button>' +
          '<span class="meta">dibuka ' + (tautan.views || 0) + '×</span></div>'
        : '<div class="btnrow"><button class="btn" data-share="' + esc(s.session_key) + '">Bagikan</button></div>';

      const sisaPlan = Math.max(0, rencana.length - 2);

      return '<div class="card clickable-card ' + cardCls + '" data-session-key="' + esc(s.session_key) + '">' +
        '<div class="row"><span class="' + chipCls + '">' + chipText + '</span>' +
        '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' +
        esc(String(s.agent_tool || 'unknown').toUpperCase()) + '</span>' +
        '<span class="task">' + esc(s.task || '(tanpa task)') + '</span></div>' +
        (s.session_title ? '<div class="meta" style="color:#79c0ff;margin-top:2px">💬 ' + esc(s.session_title) + '</div>' : '') +
        note +
        '<div class="meta">' + esc(s.machine) + ' · ' + esc(s.project_name) +
        ' · ' + esc(s.task_type) + ' · ' + ago(s.updated_at, jNow) + '</div>' +
        (total ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="meta">rencana ' + done + '/' + total + ' · DoD ' + s.dod_done + '/' + s.dod_total +
          (s.dod_waived ? ' (' + s.dod_waived + ' dilewati)' : '') + '</div>' : '') +
        (plan ? '<ul>' + plan + '</ul>' : '') +
        (sisaPlan > 0 ? '<div class="meta" style="margin-top:4px;color:#7d8590">+' + sisaPlan + ' langkah lagi</div>' : '') +
        '<div class="detail-hint">ketuk untuk detail ›</div>' +
        tombolShare +
        '</div>';
    }).join('');
  }

  // Riwayat
  renderHistory(data);

  // Rekap
  document.getElementById('summaryTitle').textContent =
    'Waktu per proyek · ' + (data.summary_days || 7) + ' hari (hanya yang sudah selesai)';
  document.getElementById('summary').innerHTML = (data.summary || []).map(r =>
    '<div class="card"><div class="row"><b style="color:#79c0ff;font-size:15px">' + esc(r.project) + '</b>' +
    '<span style="margin-left:auto;font-weight:700;color:#3fb950">' + esc(r.total_label || '-') + '</span></div>' +
    '<div class="meta" style="margin-top:4px">' + r.sessions + ' sesi selesai · terakhir ' + ago(r.last_at, jNow) + '</div></div>'
  ).join('') || '<div class="empty">belum ada sesi selesai</div>';

  // Mesin
  document.getElementById('machines').innerHTML = (data.machines || []).map(m =>
    '<div class="card"><div class="row"><b style="color:' + (m.stale ? '#d29922' : '#3fb950') + '">' + (m.stale ? '⚠ ' : '● ') + '</b> ' +
    '<b>' + esc(m.machine) + '</b><span class="meta" style="margin-left:auto">terakhir melapor ' + ago(m.last_seen, jNow) + '</span></div>' +
    '<div class="meta" style="margin-top:4px">' + m.sessions + ' sesi · fase terakhir ' + esc(m.last_phase || '-') +
    (m.last_project ? ' · ' + esc(m.last_project) : '') +
    (m.stale ? ' · sudah lama tidak melapor' : '') + '</div></div>'
  ).join('') || '<div class="empty">belum ada mesin terhubung</div>';

  // Events
  document.getElementById('events').innerHTML = (data.events || []).map(e =>
    '<div style="padding:4px 0"><b>' + esc(e.kind) + '</b> ' + esc(e.detail) +
    '<span class="meta"> · ' + esc(e.project_name) + ' · ' + ago(e.at, jNow) + '</span></div>').join('')
    || '<div>—</div>';

  // Info
  const serverEl = document.getElementById('serverInfo');
  if (serverEl) {
    serverEl.innerHTML =
      '<b>URL:</b> ' + esc(window.location.origin) + '<br>' +
      '<b>Status:</b> ' + data.sessions.length + ' sesi aktif · ' + (data.history || []).length + ' riwayat · ' + (data.machines || []).length + ' mesin<br>' +
      '<b>Pembaruan:</b> tiap ' + Math.round(${POLL_MS} / 1000) + ' detik';
  }

  // Update modal jika sedang terbuka
  if (activeDetailKey) {
    bukaDetail(activeDetailKey);
  }
}

async function tick() {
  try {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    document.getElementById('sub').textContent = 'terputus: ' + e.message;
  }
}

async function muatTautan() {
  var box = document.getElementById('tautan');
  try {
    var r = await fetch('/api/share?all=1', { headers: { 'x-devwf-share': '1' } });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || ('server menjawab ' + r.status));
    var daftar = data.shares || [];
    if (!daftar.length) {
      box.innerHTML = '<div class="empty">tidak ada tautan yang hidup</div>';
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
      return '<div class="card" style="margin:6px 0"><div class="row"><b style="color:#c9d1d9">' + esc(s.label) + '</b> ' +
        catatan +
        '<span class="meta" style="margin-left:auto">dibuka ' + (s.views || 0) + 'x · ' + ago(s.createdAt, Date.now()) + '</span></div>' +
        '<div class="btnrow">' +
        '<button class="btn" data-copy="' + esc(s.url) + '">Salin</button>' +
        '<button class="btn danger" data-revoke="' + esc(s.token) + '">Cabut</button>' +
        '</div></div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div style="color:#ff7b72">gagal memuat tautan: ' + esc(e.message) + '</div>';
  }
}

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

// Delegasi klik pada elemen
document.getElementById('list').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-share],[data-copy],[data-revoke]');
  if (btn) {
    if (btn.dataset.share) { void tombolBagikan(btn.dataset.share, btn); }
    else if (btn.dataset.copy) { void tombolSalin(btn.dataset.copy, btn); }
    else if (btn.dataset.revoke) { void tombolCabut(btn.dataset.revoke, btn); }
    return;
  }
  var card = e.target.closest('[data-session-key]');
  if (card) {
    bukaDetail(card.dataset.sessionKey);
  }
});

document.getElementById('history').addEventListener('click', function (e) {
  var card = e.target.closest('[data-session-key]');
  if (card) {
    bukaDetail(card.dataset.sessionKey);
  }
});

document.getElementById('history-filters').addEventListener('click', function (e) {
  var fChip = e.target.closest('.filter-chip');
  if (fChip && fChip.dataset.filter) {
    pilihFilter(fChip.dataset.filter);
  }
});

document.querySelector('.tabbar').addEventListener('click', function (e) {
  var tabBtn = e.target.closest('.tab-btn');
  if (tabBtn && tabBtn.dataset.tab) {
    pilihTab(tabBtn.dataset.tab);
  }
});

document.getElementById('modal-detail').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-share],[data-copy],[data-revoke]');
  if (btn) {
    if (btn.dataset.share) { void tombolBagikan(btn.dataset.share, btn); }
    else if (btn.dataset.copy) { void tombolSalin(btn.dataset.copy, btn); }
    else if (btn.dataset.revoke) { void tombolCabut(btn.dataset.revoke, btn); }
    return;
  }
  if (e.target.matches('.modal-backdrop') || e.target.closest('.modal-close') || e.target.closest('#modal-tutup-btn')) {
    tutupModal();
  }
});

document.getElementById('tautan').addEventListener('click', function (e) {
  var t = e.target.closest('[data-copy],[data-revoke],[data-revoke-orphans]');
  if (!t) return;
  if (t.dataset.revokeOrphans) { void cabutYatim(t); }
  else if (t.dataset.copy) { void tombolSalin(t.dataset.copy, t); }
  else if (t.dataset.revoke) { void tombolCabut(t.dataset.revoke, t); }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') tutupModal();
});

// Handler tombol "Tutup Sesi" (force-close sesi macet dari dashboard)
document.addEventListener('click', async function(e) {
  var btn = e.target.closest('#modal-close-session-btn');
  if (!btn) return;
  var sessionKey = btn.dataset.sessionKey;
  if (!sessionKey) return;
  if (!confirm('Yakin ingin menutup paksa sesi ini?\n' + sessionKey + '\n\nSesi akan diset ke phase "closed".')) return;
  btn.disabled = true;
  btn.textContent = 'Menutup…';
  try {
    var r = await fetch('/api/session/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-devwf-close': '1' },
      body: JSON.stringify({ sessionKey: sessionKey })
    });
    var json = await r.json();
    if (json.ok) {
      btn.textContent = '✓ Ditutup';
      btn.style.background = '#1a7f371a';
      btn.style.color = '#3fb950';
      btn.style.borderColor = '#1a7f3755';
      setTimeout(function() { tutupModal(); tick(); }, 1200);
    } else {
      btn.disabled = false;
      btn.textContent = '✕ Tutup Sesi';
      alert('Gagal menutup: ' + (json.error || JSON.stringify(json)));
    }
  } catch(err) {
    btn.disabled = false;
    btn.textContent = '✕ Tutup Sesi';
    alert('Error: ' + err.message);
  }
});

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
    if (url.pathname === '/api/session/close' && req.method === 'POST') {
      const authOk = writeAllowed(req) || req.headers['x-devwf-share'] === '1' || req.headers['x-devwf-close'] === '1';
      if (!authOk) {
        return denyWrite(res);
      }
      const body = bacaJson(await readBody(req), res);
      if (body === null) return undefined;
      const sessionKey = String(body.sessionKey || body.session_key || '');
      if (!sessionKey) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'sessionKey diperlukan' }));
      }
      const result = await query(
        `UPDATE sessions SET phase = 'closed', updated_at = NOW()
          WHERE session_key = $1
            AND phase NOT IN ('closed','done','cancelled')
          RETURNING session_key, machine, project_name`,
        [sessionKey],
      );
      if (result.rowCount === 0) {
        // Sudah closed atau tidak ditemukan — tidak apa-apa
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, closed: false, reason: 'sudah closed atau tidak ditemukan' }));
      }
      const row = result.rows[0];
      console.log(`[session/close] ${row.session_key} (${row.machine}/${row.project_name}) ditutup manual.`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, closed: true, sessionKey: row.session_key }));
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



