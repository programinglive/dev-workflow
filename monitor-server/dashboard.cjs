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
const { visibleTaskSessions } = require('./visible-task-sessions.cjs');
const {
  buildPruneEventsQuery,
  buildPruneSessionsQuery,
  isWriteAuthorized,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_DAYS,
} = require('./retention.cjs');
const { buildHealth, DEFAULT_STALE_AFTER_MS } = require('./health.cjs');
const { buildMachinesQuery, DEFAULT_STALE_AFTER_DAYS, visibleMachines } = require('./machines-query.cjs');
const { buildFleetParity } = require('./fleet-parity.cjs');
const { dedupeSessions } = require('./dedupe-sessions.cjs');
const { buildReportQuery, buildReportPayload, estimateBuild } = require('./build-report.cjs');
const { withRepoLink } = require('./repo-link.cjs');
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
const { buildSessionUpsert, buildParentHandoff } = require('./session-upsert.cjs');
const { chainLabels, buildForCard, cardKey } = require('./card-chain.cjs');
const { normalizeTaskMetadata, renderTaskMetadata } = require('./task-metadata.cjs');
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
const { normalizeBuildState, extractActiveBuildFromEvents } = require('./build-monitor.cjs');
const { shouldSkipCreate } = require('./empty-session.cjs');
const { handlePairVerify, handlePairStatus } = require('./mobile-pair-route.cjs');

let pairingEnginePromise = null;
function getPairingEngine() {
  if (!pairingEnginePromise) {
    pairingEnginePromise = import('../pairing/challenge.js').catch((err) => {
      console.error('Failed to load pairing challenge engine:', err);
      return null;
    });
  }
  return pairingEnginePromise;
}

const liveBuildsBySession = new Map();

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
  process.env.DEVWF_SHARE_ORIGINS || 'http://100.77.138.14:3100,http://localhost:3100',
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
const EMPTY_IDLE_TTL = process.env.EMPTY_IDLE_TTL || '1 minute';

const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 4 }) : null;
const ZETTLY_DB_URL = process.env.ZETTLY_DATABASE_URL || (DB_URL ? DB_URL.replace(/\/devwf_monitor(\?|$)/, '/prod_zettly$1') : '');
const zettlyPool = ZETTLY_DB_URL ? new pg.Pool({ connectionString: ZETTLY_DB_URL, max: 2 }) : null;

async function fetchDrawing(id) {
  if (zettlyPool) {
    try {
      const res = await zettlyPool.query('SELECT id, title, thumbnail FROM drawings WHERE id = $1', [id]);
      if (res.rows && res.rows[0]) return res.rows[0];
    } catch (e) {
      console.error('fetchDrawing error:', e.message);
    }
  }
  return null;
}

/** Zettly stores the drawing as an SVG data URI; unwrap it to plain markup. */
function drawingSvg(thumbnail) {
  let svg = String(thumbnail || '');
  if (svg.startsWith('data:image/svg+xml;charset=utf-8,')) {
    svg = decodeURIComponent(svg.slice('data:image/svg+xml;charset=utf-8,'.length));
  } else if (svg.startsWith('data:image/svg+xml;base64,')) {
    svg = Buffer.from(svg.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  }
  return svg;
}

/**
 * Raster copy of a drawing.
 *
 * The tablet app draws the flow with React Native's <Image>, which cannot
 * render SVG at all. It asks for /thumbnail.png, and that route did not exist,
 * so the flow was a 404 on the one device the owner actually carries. sharp is
 * loaded lazily: a host without it still serves the SVG and the browser
 * dashboard keeps working.
 */
let sharpModule;
function getSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = require('sharp');
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

const pngCache = new Map();

async function renderDrawingPng(id, svg) {
  const cached = pngCache.get(id);
  if (cached && cached.svgLength === svg.length) return cached.buffer;

  const sharp = getSharp();
  if (!sharp) throw new Error('sharp tidak tersedia untuk merender PNG');

  const buffer = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  pngCache.set(id, { svgLength: svg.length, buffer });
  if (pngCache.size > 50) pngCache.delete(pngCache.keys().next().value);
  return buffer;
}

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Workflow Monitor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
         background:#070a0f; color:#e6edf3; padding:16px 18px 84px; max-width:1440px; margin-inline:auto; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
            padding:12px 16px; margin-bottom:16px; border-radius:12px;
            background:linear-gradient(135deg,#0f1722 0%,#0b1017 100%); border:1px solid #1f2937; }
  .brand { display:flex; align-items:center; gap:10px; }
  .live-dot { width:10px; height:10px; border-radius:50%; background:#3fb950;
              box-shadow:0 0 0 4px #3fb95022; animation:pulseDot 2s infinite; }
  @keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:.55;transform:scale(1.15);} }
  h1 { font-size:18px; margin:0; letter-spacing:-.2px; }
  .sub { color:#8b949e; font-size:12px; margin:2px 0 0; }

  /* KPI Strip */
  .kpi-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:10px; margin-bottom:16px; }
  .kpi-card { background:#0d131c; border:1px solid #1e2631; border-radius:10px; padding:10px 14px;
              display:flex; flex-direction:column; gap:2px; }
  .kpi-card.building-active { border-color:#d2992288; background:linear-gradient(135deg,#1c160c 0%,#0d131c 100%); }
  .kpi-lbl { font-size:11px; color:#8b949e; text-transform:uppercase; letter-spacing:.5px; }
  .kpi-val { font-size:22px; font-weight:700; color:#f0f6fc; line-height:1.2; }
  .kpi-sub { font-size:11px; color:#7d8590; }

  /* Live Build Monitor Hero Section */
  .build-hero { margin-bottom:18px; border-radius:12px; padding:14px 16px;
                background:linear-gradient(135deg,#121d2f 0%,#0d131d 100%);
                border:1px solid #2f81f766; box-shadow:0 8px 24px rgba(0,0,0,.35); }
  .build-hero-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  .build-hero-title { font-size:14px; font-weight:700; color:#79c0ff; display:flex; align-items:center; gap:8px; }
  .build-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr)); gap:12px; }
  .build-card { background:#090d13; border:1px solid #263345; border-radius:10px; padding:12px 14px;
                cursor:pointer; transition:border-color .15s, transform .15s; }
  .build-card:hover { border-color:#58a6ff; transform:translateY(-1px); }
  .build-card.building, .build-card.testing, .build-card.scanning, .build-card.deploying {
    border-color:#d2992288; box-shadow:0 0 0 1px #d2992222;
  }
  .build-card.succeeded { border-color:#23863688; }
  .build-card.failed { border-color:#f8514988; }
  .build-badge { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700;
                 padding:2px 9px; border-radius:999px; text-transform:uppercase; letter-spacing:.4px; }
  .build-badge.building, .build-badge.testing, .build-badge.scanning, .build-badge.deploying {
    background:#d2992226; color:#f0c674; border:1px solid #d2992266;
  }
  .build-badge.succeeded { background:#2ea04326; color:#3fb950; border:1px solid #2ea04366; }
  .build-badge.failed { background:#f8514926; color:#ff7b72; border:1px solid #f8514966; }
  .build-target { font-weight:700; font-size:14px; color:#f0f6fc; margin-top:6px; }
  .build-job-link {
    display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600;
    color:#58a6ff; text-decoration:none; padding:2px 7px; border-radius:6px;
    background:#1f6feb22; border:1px solid #1f6feb44; transition:background .15s, border-color .15s;
  }
  .build-job-link:hover {
    background:#1f6feb44; border-color:#58a6ff; text-decoration:none; color:#79c0ff;
  }
  .build-location { color:#a5d6ff; font-size:12px; font-weight:600; margin-top:7px; overflow-wrap:anywhere; }
  .build-stage { font-size:12px; color:#a5d6ff; margin-top:3px; }
  .build-cmd { margin-top:8px; padding:7px 9px; background:#05080c; border:1px solid #1b222c;
               border-radius:7px; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;
               color:#9da7b3; overflow-x:auto; white-space:pre-wrap; word-break:break-all; }
  .build-bar { height:7px; background:#1b222c; border-radius:999px; overflow:hidden; margin:9px 0 4px; position:relative; }
  .build-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#2f81f7,#58a6ff); transition:width .3s ease; }
  .build-bar.indeterminate > i { width:45% !important; background:linear-gradient(90deg,#d29922,#f0c674,#d29922);
                                 animation:shimmerBar 1.6s infinite ease-in-out; }
  @keyframes shimmerBar { 0%{transform:translateX(-80%);} 100%{transform:translateX(220%);} }

  /* Workflow Pipeline Stepper */
  .pipeline { display:flex; align-items:center; gap:4px; margin:10px 0 8px; flex-wrap:wrap; }
  .pipe-step { font-size:10px; padding:2px 7px; border-radius:6px; background:#141b23;
               color:#6e7681; border:1px solid #21262d; font-weight:600; }
  .pipe-step.done { background:#12261e; color:#3fb950; border-color:#23863666; }
  .pipe-step.current { background:#1f6feb33; color:#79c0ff; border-color:#2f81f7; box-shadow:0 0 8px #2f81f733; }

  /* Session Grid & Cards */
  #list { display:grid; grid-template-columns:repeat(auto-fit,minmax(350px,1fr)); gap:12px; }
  .card { border:1px solid #21262d; border-radius:12px; padding:14px; margin-bottom:12px;
          background:#0f151c; display:flex; flex-direction:column; }
  #list .card { margin-bottom:0; }
  .card.live { border-color:#2f81f7; box-shadow:0 0 0 1px #2f81f744; }
  .card.stuck { border-color:#d2992255; box-shadow:0 0 0 1px #d2992233; }
  .card.ended { opacity:.62; }
  .clickable-card { cursor:pointer; transition:border-color .15s, background-color .15s, transform .15s; }
  .clickable-card:hover { border-color:#58a6ff88; background:#131a24; transform:translateY(-1px); }
  .repo-link { color:#2f81f7; text-decoration:none; font-size:12px; word-break:break-all; }
  .repo-link:hover { text-decoration:underline; color:#58a6ff; }
  .build-eta { margin-top:6px; color:#3fb950; font-weight:600; font-size:12px; }
  .build-eta.warn { color:#d29922; }
  .phase.stuck { background:#d2992222; color:#e3b341; border-color:#d2992255; }
  .phase.ended { background:#6e768122; color:#8b949e; border-color:#6e768155; }
  .row { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .task { font-weight:600; color:#f0f6fc; }
  .meta { color:#7d8590; font-size:12px; }
  .task-metadata { margin-top:6px; overflow-wrap:anywhere; }
  .task-metadata a { color:#79c0ff; }
  .task-relation-list { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-top:4px; }
  .task-relation { display:inline-flex; align-items:center; max-width:100%; padding:2px 8px; border:1px solid #2d3b50; border-radius:999px; background:#101a2a; overflow-wrap:anywhere; }
  .task-relation-factory { border-color:#9e6a2266; background:#2a1c0e; }
  .task-relation-zettly_draw { border-color:#8b5cf666; background:#201630; }
  .flow-preview { margin-top:8px; }
  .flow-thumb-box { transition:border-color .15s ease, box-shadow .15s ease; }
  .flow-thumb-box:hover { border-color:#58a6ff !important; box-shadow:0 0 0 1px #58a6ff44; }
  .flow-thumb-box:hover .flow-thumb-hint { background:#1f6febdd !important; color:#fff !important; }
  .proj-pill { display:inline-block; background:#1f6feb1a; color:#58a6ff; border:1px solid #1f6feb44;
               padding:1px 8px; border-radius:6px; font-weight:600; font-size:11px; }
  .phase { background:#1f6feb22; color:#79c0ff; border:1px solid #1f6feb55;
           border-radius:999px; padding:1px 9px; font-size:11px; text-transform:uppercase;
           letter-spacing:.4px; }
  .bar { height:6px; background:#21262d; border-radius:999px; overflow:hidden; margin:10px 0 4px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#2f81f7,#3fb950); }
  ul { list-style:none; margin:8px 0 0; padding:0; font-size:13px; }
  li { padding:2px 0; color:#9da7b3; }
  li.done { color:#3fb950; text-decoration:line-through; }
  .empty { color:#7d8590; text-align:center; padding:40px 0; grid-column:1 / -1; }
  .events { font-size:12px; color:#7d8590; }
  .events b { color:#c9d1d9; font-weight:500; }
  .event-row { padding:7px 10px; border-bottom:1px solid #161b22; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
  .event-row:last-child { border-bottom:none; }

  /* Activity Box & Build Event Cards */
  .activity-box { background:#0d131d; border:1px solid #212d3d; }
  .events-scroll-container { max-height:360px; overflow-y:auto; padding-right:4px; scrollbar-width:thin; scrollbar-color:#30363d #090d13; }
  .events-scroll-container::-webkit-scrollbar { width:6px; }
  .events-scroll-container::-webkit-scrollbar-track { background:#090d13; border-radius:4px; }
  .events-scroll-container::-webkit-scrollbar-thumb { background:#30363d; border-radius:4px; }
  .event-card { background:#090d13; border:1px solid #21262d; border-radius:8px; padding:10px 12px; margin-bottom:8px; font-size:12px; transition:border-color .15s; }
  .event-card:hover { border-color:#388bfd55; }
  .event-card.build.succeeded { border-left:4px solid #2ea043; background:linear-gradient(90deg, rgba(46,160,67,0.06) 0%, #090d13 25%); }
  .event-card.build.building, .event-card.build.testing, .event-card.build.scanning, .event-card.build.deploying { border-left:4px solid #d29922; background:linear-gradient(90deg, rgba(210,153,34,0.06) 0%, #090d13 25%); }
  .event-card.build.failed { border-left:4px solid #f85149; background:linear-gradient(90deg, rgba(248,81,73,0.08) 0%, #090d13 25%); }
  .event-card.generic { border-left:4px solid #388bfd; }
  .event-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
  .event-title-line { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .event-target-text { font-weight:700; color:#f0f6fc; font-size:13px; }
  .event-meta-line { font-size:11px; color:#7d8590; display:flex; align-items:center; gap:6px; margin-left:auto; }
  .event-host-pill { background:#161b22; border:1px solid #30363d; border-radius:4px; padding:1px 6px; color:#a5d6ff; font-size:11px; }
  .event-stage-line { color:#79c0ff; font-size:12px; margin:4px 0 2px; font-weight:500; display:flex; align-items:center; gap:6px; }
  .event-cmd-box { font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; background:#05080c; border:1px solid #1b222c; border-radius:6px; padding:5px 8px; color:#8b949e; margin-top:6px; word-break:break-all; }
  .event-out-box { font-size:12px; line-height:1.5; color:#e6edf3; background:#101620; border-radius:6px; padding:8px 10px; margin-top:6px; border:1px solid #1f2937; white-space:pre-wrap; word-break:break-word; }
  .event-kind-tag { background:#1f6feb22; color:#79c0ff; border:1px solid #1f6feb44; border-radius:4px; padding:1px 6px; font-weight:600; font-size:10px; text-transform:uppercase; }
  .event-detail-text { color:#c9d1d9; font-weight:500; }
  .warn { border:1px solid #d2992255; background:#d299221a; color:#e3b341;
          border-radius:10px; padding:10px 12px; margin-bottom:12px; font-size:13px; }
  .warn b { color:#f0c674; }
  .btnrow { display:flex; gap:8px; align-items:center; margin-top:auto; padding-top:10px; flex-wrap:wrap; }
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
    position: fixed; bottom: 0; left: 0; right: 0; height: 58px;
    background: rgba(13, 17, 23, 0.94); backdrop-filter: blur(10px); border-top: 1px solid #21262d;
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
    border-radius: 12px; max-width: 640px; width: 100%; max-height: 88vh;
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
<header class="topbar">
  <div class="brand">
    <span class="live-dot"></span>
    <div>
      <h1>Dev Workflow Monitor</h1>
      <div class="sub" id="sub">menyambung…</div>
    </div>
  </div>
</header>

<div id="kpi-strip" class="kpi-strip"></div>

<!-- TAB 1: AKTIF -->
<div id="tab-aktif" class="tab-pane active">
  <div id="warn"></div>
  <div id="alerts"></div>
  <div id="build-monitor"></div>

  <!-- AKTIVITAS & BUILD LOG TERAKHIR (HIGH VISIBILITY: ABOVE ACTIVE SESSIONS) -->
  <div class="card activity-box" id="activity-section" style="padding:12px 14px;margin-bottom:18px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <h1 style="font-size:14px;margin:0;color:#f0f6fc;display:flex;align-items:center;gap:6px">
          <span>⚡ Aktivitas &amp; Build Log Terakhir</span>
        </h1>
        <span class="meta" id="events-count-badge" style="font-size:11px;background:#21262d;padding:1px 7px;border-radius:999px;color:#a5d6ff"></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button id="filter-all-events" class="filter-chip active" style="padding:2px 8px;font-size:11px" onclick="setEventFilter('all')">Semua</button>
        <button id="filter-build-events" class="filter-chip" style="padding:2px 8px;font-size:11px" onclick="setEventFilter('build')">Build saja</button>
        <button id="btn-toggle-events" class="btn" style="padding:2px 8px;font-size:11px" onclick="toggleEventsCollapse()">Sembunyikan</button>
      </div>
    </div>
    <div id="events-scroll-container" class="events-scroll-container">
      <div id="events" class="events"></div>
    </div>
  </div>

  <h1 style="font-size:14px;margin:20px 0 10px;color:#f0f6fc">Sesi Aktif</h1>
  <div id="list"><div class="empty">memuat…</div></div>
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
<div id="tab-build" class="tab-pane">
  <div class="grid" id="build-report"></div>
  <div class="meta" style="margin-top:8px">Durasi dari build lokal yang dilaporkan report_build_status; jendela 30 hari (batas retensi event).</div>
</div>
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
  <button class="tab-btn" data-tab="build"><span class="tab-icon">⏳</span><span class="tab-lbl">Build</span></button>
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
      <div id="modal-task-metadata"></div>
      <div class="modal-session-title" id="modal-session-title"></div>
      <div class="modal-project" id="modal-project"></div>
      <div class="meta" id="modal-meta"></div>
      <div class="meta" id="modal-path" style="word-break:break-all;margin-top:4px"></div>
      <div id="modal-timer"></div>
      <div id="modal-build"></div>
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

<!-- MODAL FLOW PREVIEW -->
<div id="modal-flow" class="modal" style="display:none;z-index:1100">
  <div class="modal-backdrop" id="modal-flow-backdrop"></div>
  <div class="modal-box" style="max-width:920px;width:95vw;">
    <div class="modal-header">
      <div class="row">
        <span class="phase" style="background:#8b5cf622;color:#a78bfa;border-color:#8b5cf655">📐 FLOW DIAGRAM</span>
        <span id="modal-flow-title" style="font-weight:600;font-size:14px;color:#f0f6fc"></span>
      </div>
      <button class="modal-close" id="modal-flow-close-btn">&times;</button>
    </div>
    <div class="modal-body" style="text-align:center;padding:16px;">
      <div id="modal-flow-loading" style="padding:40px;color:#8b949e">Memuat diagram flow...</div>
      <div id="modal-flow-container" style="background:#0b1020;border:1px solid #30363d;border-radius:8px;padding:12px;overflow:auto;max-height:70vh;display:flex;align-items:center;justify-content:center;">
        <img id="modal-flow-img" src="" alt="Flow Diagram" style="max-width:100%;height:auto;object-fit:contain;display:none;" />
      </div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;">
      <a id="modal-flow-link" href="#" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">
        Buka di Zettly Draw ↗
      </a>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="modal-flow-png-btn" style="background:#238636;color:#fff;border-color:#2ea043">
          💾 Download PNG
        </button>
        <button class="btn" id="modal-flow-tutup-btn">Tutup</button>
      </div>
    </div>
  </div>
</div>

<script>
const visibleTaskSessions = ${visibleTaskSessions.toString()};
const normalizeTaskMetadata = ${normalizeTaskMetadata.toString()};
const renderTaskMetadata = ${renderTaskMetadata.toString()};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function renderChain(s) {
  const from = String((s && s.chain_from) || '').trim();
  const to = String((s && s.chain_to) || '').trim();
  if (!from && !to) return '';
  return '<div class="meta" style="color:#d2a8ff;margin-top:2px">' +
    (from ? '↩ lanjutan dari "' + esc(from) + '"' : '') +
    (from && to ? ' · ' : '') +
    (to ? '↪ dilanjutkan ke "' + esc(to) + '"' : '') +
    '</div>';
}

/**
 * Repository link for a session.
 *
 * The URL is built on the server (monitor-server/repo-link.cjs), so every
 * client shows the same address and the conversion itself is covered by tests.
 */
function repoLinkHtml(s) {
  if (!s || !s.repo_url) return '';
  const label = s.repo_label || s.repo_url;
  return '<a class="repo-link" href="' + esc(s.repo_url) + '" target="_blank" rel="noopener noreferrer"' +
    ' title="' + esc(s.repo_url) + '">🔗 ' + esc(label) + ' ↗</a>';
}
/**
 * The approved flow diagram of this task, taken from task_relations_json.
 *
 * The monitor has rendered flow thumbnails through /api/drawings/:id/thumbnail
 * and openFlowModal for a while, but nothing ever emitted an element with
 * data-flow-id, so there was no way to open the modal: the diagram existed and
 * was unreachable. The relation is already stored - it just was never read.
 */
function flowRelation(s) {
  const raw = s && s.task_relations_json;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item && item.system === 'zettly_draw' && item.id) {
      return {
        id: String(item.id),
        label: String(item.label || ('Draw #' + item.id)),
        url: String(item.url || ''),
      };
    }
  }
  return null;
}

function flowChipHtml(s) {
  const rel = flowRelation(s);
  if (!rel) return '';
  return '<button type="button" data-flow-id="' + esc(rel.id) + '"' +
    ' data-flow-title="' + esc(rel.label) + '"' +
    ' data-flow-url="' + esc(rel.url) + '"' +
    ' style="margin:6px 0 0;padding:5px 12px;border-radius:999px;cursor:pointer;' +
    'background:#1f6feb22;border:1px solid #1f6feb66;color:#79c0ff;font-size:12px">' +
    'Lihat diagram flow</button>';
}

/**
 * What refine_with_ai actually asked for, revision by revision.
 *
 * Without this the monitor can only show the CURRENT description, so a task
 * refined four times looks like it was always described that way.
 */
function renderRefinementHistory(s) {
  const r = s && s.refinement_json;
  if (!r || !Array.isArray(r.history) || r.history.length === 0) return '';

  const entries = r.history.slice(-10).reverse().map(function(entry) {
    const when = entry.at ? new Date(entry.at).toLocaleString('id-ID') : 'waktu tidak tercatat';
    const plan = Array.isArray(entry.plan) ? entry.plan.length : 0;
    const dod = Array.isArray(entry.definitionOfDone) ? entry.definitionOfDone.length : 0;
    return '<div class="event-card" style="margin-top:8px">' +
      '<div class="row" style="justify-content:space-between;align-items:center">' +
        '<span class="phase" style="background:#2ea04322;color:#7ee787;border-color:#2ea04355">revisi ' +
          esc(String(entry.revision || '?')) + '</span>' +
        '<span class="meta">' + esc(when) + '</span>' +
      '</div>' +
      '<div style="margin-top:6px">' + esc(entry.description || '') + '</div>' +
      (entry.newContext ? '<div class="meta" style="margin-top:4px">Konteks baru: ' + esc(entry.newContext) + '</div>' : '') +
      '<div class="meta" style="margin-top:4px">' + plan + ' langkah rencana / ' + dod + ' item DoD</div>' +
      '</div>';
  }).join('');

  return '<div class="modal-sec-title">Riwayat Refinement AI (' + r.history.length + ' revisi)</div>' + entries;
}

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
function durasiDetik(isoMulai, msSekarang) {
  if (!isoMulai) return '';
  const d = Math.max(0, Math.floor(((msSekarang || Date.now()) - new Date(isoMulai).getTime()) / 1000));
  if (!isFinite(d)) return '';
  const m = Math.floor(d / 60);
  const s = d % 60;
  const j = Math.floor(m / 60);
  const sisaM = m % 60;
  if (j > 0) return j + 'j ' + (sisaM < 10 ? '0' : '') + sisaM + 'm ' + (s < 10 ? '0' : '') + s + 'd';
  if (m > 0) return m + 'm ' + (s < 10 ? '0' : '') + s + 'd';
  return s + 'd';
}
function labelBuildStatus(st) {
  const k = String(st || 'building').toLowerCase();
  if (k === 'building') return '🔨 BUILDING';
  if (k === 'testing') return '🧪 TESTING';
  if (k === 'scanning') return '🛡️ SCANNING';
  if (k === 'deploying') return '🚀 DEPLOYING';
  if (k === 'succeeded') return '✅ BUILD SUKSES';
  if (k === 'failed') return '❌ BUILD GAGAL';
  return '⏸️ IDLE';
}
function renderPipeline(s) {
  const phase = String(s.phase || 'coding').toLowerCase();
  const order = [
    { id: 'coding', lbl: '1. Code' },
    { id: 'testing', lbl: '2. Build & Test' },
    { id: 'documentation', lbl: '3. Docs' },
    { id: 'ready', lbl: '4. Ready' },
    { id: 'commit', lbl: '5. Commit' },
    { id: 'release', lbl: '6. Release' }
  ];
  const idxMap = { coding: 0, testing: 1, documentation: 2, ready: 3, commit: 4, release: 5, ready_to_complete: 6 };
  const curIdx = idxMap[phase] !== undefined ? idxMap[phase] : 0;
  return '<div class="pipeline">' + order.map(function(step, idx) {
    var cls = idx < curIdx ? 'pipe-step done' : (idx === curIdx ? 'pipe-step current' : 'pipe-step');
    return '<span class="' + cls + '">' + (idx < curIdx ? '✓ ' : '') + esc(step.lbl) + '</span>';
  }).join('') + '</div>';
}
function renderBuildLocation(ab, machine) {
  const host = ab.buildHost || machine || '';
  if (host) {
    const isRemoteVm = machine && host.toLowerCase() !== machine.toLowerCase();
    const tag = isRemoteVm
      ? ' <span class="badge" style="background:#4338ca;color:#fff;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px">Remote VM</span>'
      : ' <span class="badge" style="background:#0284c7;color:#fff;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px">Lokal</span>';
    const reporter = isRemoteVm ? ' <span class="meta" style="font-size:11px;opacity:0.8">· Pelapor ' + esc(machine) + '</span>' : '';
    return '<div class="build-location">🏗️ Mesin Builder: <strong>' + esc(host) + '</strong>' + tag + reporter + '</div>';
  }
  return '<div class="build-location">🏗️ Mesin Builder: <strong>Lokal</strong>' + (machine ? ' <span class="meta">(' + esc(machine) + ')</span>' : '') + '</div>';
}
function renderBuildBox(ab, jNow, machine) {
  if (!ab || !ab.target) return '';
  const st = String(ab.status || 'building').toLowerCase();
  const isRunning = st === 'building' || st === 'testing' || st === 'scanning' || st === 'deploying';
  const hasPct = typeof ab.progress === 'number' && isFinite(ab.progress);
  const pct = hasPct ? Math.max(0, Math.min(100, Math.round(ab.progress))) : 45;
  const barCls = (!hasPct && isRunning) ? 'build-bar indeterminate' : 'build-bar';
  const elapsed = ab.startedAt ? durasiDetik(ab.startedAt, ab.finishedAt ? new Date(ab.finishedAt).getTime() : jNow) : '';
  const liveAttr = (isRunning && ab.startedAt) ? ' data-live-start="' + esc(ab.startedAt) + '"' : '';
  const eta = renderEta(ab, jNow);
  const rawJobUrl = ab.jobUrl || ab.url || ab.buildUrl || '';
  let validJobUrl = '';
  if (rawJobUrl) {
    try {
      const u = new URL(rawJobUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') validJobUrl = u.href;
    } catch {}
  }
  const jobLink = validJobUrl
    ? '<a href="' + esc(validJobUrl) + '" target="_blank" rel="noopener noreferrer" class="build-job-link" onclick="event.stopPropagation()">' +
      'Buka job' +
      '<span style="font-weight:400;opacity:.85;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(validJobUrl.replace('https://', '').replace('http://', '')) + '</span></a>'
    : '';
  return '<div class="build-card ' + esc(st) + '" style="margin-top:10px">' +
    '<div class="row" style="justify-content:space-between;align-items:center">' +
      '<span class="build-badge ' + esc(st) + '">' + labelBuildStatus(st) + '</span>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        jobLink +
        (elapsed ? '<span class="meta"' + liveAttr + '>⏱ ' + esc(elapsed) + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="build-target">🏗️ ' + esc(ab.target) + '</div>' +
    renderBuildLocation(ab, machine) +
    eta +
    (ab.stage ? '<div class="build-stage">▸ ' + esc(ab.stage) + (hasPct ? ' (' + pct + '%)' : '') + '</div>' : '') +
    '<div class="' + barCls + '"><i style="width:' + pct + '%"></i></div>' +
    renderTestCases(ab.testCases) +
    (ab.command ? '<div class="build-cmd">$ ' + esc(ab.command) + '</div>' : '') +
    (ab.output ? '<div class="event-out-box" style="margin-top:6px">' + esc(ab.output) + '</div>' : '') +
  '</div>';
}

/**
 * Per-test-case progress on a card.
 *
 * OWNER REQUEST (10 November 2026): "I want output about test cases on the
 * monitor, so we know tests are running and how far they have got." Without
 * this, a card reads "npm test (100%)" for five minutes and looks frozen.
 *
 * This function lives INSIDE the page template, so it is browser code: no
 * backticks, no template interpolation, no require(). The counts are computed
 * here rather than from the server helper for that reason.
 *
 * Only a bounded window is drawn: the running case first (that is the one
 * somebody is waiting for), then the most recent settled ones. A suite with
 * thousands of cases must not push the rest of the card off the screen.
 */
function renderTestCases(testCases) {
  if (!Array.isArray(testCases) || testCases.length === 0) return '';
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
  for (let i = 0; i < testCases.length; i++) {
    const entry = testCases[i];
    if (!entry) continue;
    if (entry.status === 'passed') counts.passed++;
    else if (entry.status === 'failed') counts.failed++;
    else if (entry.status === 'skipped') counts.skipped++;
    else if (entry.status === 'running') counts.running++;
  }
  const icon = function (status) {
    if (status === 'passed') return '✅';
    if (status === 'failed') return '❌';
    if (status === 'skipped') return '⏭️';
    if (status === 'running') return '▶️';
    return '❔';
  };
  const running = testCases.filter(function (entry) { return entry && entry.status === 'running'; });
  const failed = testCases.filter(function (entry) { return entry && entry.status === 'failed'; });
  const settled = testCases.filter(function (entry) { return entry && entry.status !== 'running'; });
  const recent = settled.slice(-6);

  const parts = [];
  if (running.length) {
    parts.push('<div class="build-stage">▶️ ' + running.slice(-2).map(function (entry) {
      return esc(entry.name);
    }).join(' · ') + '</div>');
  }
  if (recent.length) {
    parts.push('<div class="meta" style="margin-top:3px;line-height:1.55">' +
      recent.map(function (entry) {
        return icon(entry.status) + ' ' + esc(entry.name);
      }).join('<br>') + '</div>');
  }
  const failuresShown = recent.filter(function (entry) { return entry.status === 'failed'; }).length;
  if (counts.failed > failuresShown) {
    parts.push('<div class="meta" style="margin-top:3px">… and ' +
      (counts.failed - failuresShown) + ' more failed</div>');
  }

  return '<div class="test-cases" style="margin-top:6px">' +
    '<div class="meta" style="font-weight:600">🧪 Test cases: ' +
      counts.passed + ' passed · ' + counts.failed + ' failed · ' +
      counts.skipped + ' skipped · ' + counts.running + ' running (' + testCases.length + ')' +
    '</div>' +
    parts.join('') +
  '</div>';
}
/**
 * Which dev-workflow release a session is running.
 *
 * "connected" only proves a server is alive. A device left on an old release
 * looked exactly as healthy as a current one, and finding out which build was
 * answering meant SSH-ing to each machine. The version now travels with every
 * report, so the card can simply show it.
 *
 * An empty value means the device does not use the managed bootstrap, which is
 * different from "up to date" - so nothing is drawn rather than guessing.
 */
function versionPill(session) {
  const version = session && session.release_version ? String(session.release_version) : '';
  if (!version) return '';
  return '<span class="phase" title="Dev Workflow release" style="background:#3fb9501a;color:#7ee787;border-color:#3fb95055">' +
    'v' + esc(version) + '</span>';
}
const estimateBuild = ${estimateBuild.toString()};

function buildSummaryFor(ab) {
  const report = window.__buildReport;
  if (!report || !Array.isArray(report.projects)) return null;
  for (let i = 0; i < report.projects.length; i++) {
    const project = report.projects[i];
    const targets = Array.isArray(project.targets) ? project.targets : [];
    const target = targets.find(function (entry) { return entry.target === ab.target; });
    if (target) {
      return {
        count: target.count,
        p50Ms: target.p50Ms,
        p90Ms: target.p90Ms,
        stages: project.stages || [],
        stageOrder: project.stageOrder || [],
      };
    }
  }
  return null;
}

function buildMinutes(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '?';
  return Math.max(0, Math.round(ms / 60000)) + 'm';
}

function buildRangeLabel(low, high) {
  if (typeof low !== 'number' || typeof high !== 'number') return '';
  return low === high ? buildMinutes(low) : buildMinutes(low) + '–' + buildMinutes(high);
}

/**
 * One line that always says what it knows and why it changed. The states match
 * the MCP tool exactly, because both call the same estimateBuild implementation.
 */
function etaText(est) {
  if (!est) return '';
  const n = est.sampleCount;
  if (est.state === 'failed') return 'gagal setelah ' + buildMinutes(est.elapsedMs) + ' (tanpa ETA)';
  if (est.state === 'succeeded') return 'selesai ' + buildMinutes(est.elapsedMs);
  if (est.state === 'no-baseline') return 'belum ada baseline (' + n + ' build)';
  if (est.state === 'overdue') return 'lewat p90: sudah ' + buildMinutes(est.elapsedMs) + ', angka sisa tidak ditampilkan';
  if (est.state === 'stalled') {
    return 'tidak ada kemajuan ' + buildMinutes(est.elapsedMs) + ' — ' +
      buildRangeLabel(est.remainingLowMs, est.remainingHighMs) + ' (tidak dapat diandalkan)';
  }
  const basis = est.basis === 'progress' ? 'dari progress' : est.basis === 'stage' ? 'dari stage' : 'p50–p90, n=' + n;
  return '≈' + buildRangeLabel(est.remainingLowMs, est.remainingHighMs) + ' lagi (' + basis + ')';
}

function renderEta(ab, jNow) {
  if (!ab || !ab.startedAt) return '';
  // A target without history still gets a line: saying "no baseline yet" is
  // information, staying silent looks like the feature is broken.
  const summary = buildSummaryFor(ab) || { count: 0 };
  const est = estimateBuild({
    summary: summary,
    run: {
      status: ab.status,
      startedAt: ab.startedAt,
      progress: ab.progress,
      progressUpdatedAt: ab.progressUpdatedAt || ab.updatedAt,
      stage: ab.stage,
      stageStartedAt: ab.stageStartedAt,
    },
    now: jNow,
  });
  const warn = est.state === 'stalled' || est.state === 'overdue' || est.state === 'failed';
  return '<div class="build-eta' + (warn ? ' warn' : '') + '" data-eta-state="' + esc(est.state) + '">⏳ ' +
    esc(etaText(est)) + '</div>';
}

function renderBuildTab(report) {
  const el = document.getElementById('build-report');
  if (!el) return;
  const projects = report && Array.isArray(report.projects) ? report.projects : [];
  if (!projects.length) {
    el.innerHTML = '<div class="empty">belum ada build selesai dalam ' + ((report && report.window_days) || 30) + ' hari</div>';
    return;
  }
  el.innerHTML = projects.map(function (project) {
    const stages = (project.stages || []).slice(0, 4).map(function (stage) {
      return esc(stage.stage) + ' ' + buildMinutes(stage.p50Ms);
    }).join(' · ');
    return '<div class="card"><div class="row"><b style="color:#79c0ff">' + esc(project.project) + '</b>' +
      '<span class="meta" style="margin-left:auto">' + project.count + ' build</span></div>' +
      '<div class="meta" style="margin-top:4px">p50 ' + buildMinutes(project.p50Ms) + ' · p90 ' + buildMinutes(project.p90Ms) +
      ' · max ' + buildMinutes(project.maxMs) + '</div>' +
      (stages ? '<div class="meta" style="margin-top:2px">stage: ' + stages + '</div>' : '') +
      '</div>';
  }).join('');
}

function renderBuildMonitor(activeSessions, jNow) {
  const el = document.getElementById('build-monitor');
  if (!el) return;
  const buildingSessions = (activeSessions || []).filter(function(s) {
    return s.active_build && s.active_build.target;
  });
  if (!buildingSessions.length) {
    el.innerHTML = '';
    return;
  }
  const runningCount = buildingSessions.filter(function(s) {
    const st = String(s.active_build.status || '').toLowerCase();
    return st === 'building' || st === 'testing' || st === 'scanning' || st === 'deploying';
  }).length;
  el.innerHTML = '<div class="build-hero">' +
    '<div class="build-hero-head">' +
      '<div class="build-hero-title">🏗️ Live Build &amp; Execution Monitor (' +
        (runningCount > 0 ? runningCount + ' sedang berjalan' : buildingSessions.length + ' tercatat') + ')</div>' +
      '<span class="meta">Real-time dari dev-workflow MCP</span>' +
    '</div>' +
    '<div class="build-grid">' +
      buildingSessions.map(function(s) {
        const ab = s.active_build;
        const st = String(ab.status || 'building').toLowerCase();
        const isRunning = st === 'building' || st === 'testing' || st === 'scanning' || st === 'deploying';
        const hasPct = typeof ab.progress === 'number' && isFinite(ab.progress);
        const pct = hasPct ? Math.max(0, Math.min(100, Math.round(ab.progress))) : 45;
        const barCls = (!hasPct && isRunning) ? 'build-bar indeterminate' : 'build-bar';
        const elapsed = ab.startedAt ? durasiDetik(ab.startedAt, ab.finishedAt ? new Date(ab.finishedAt).getTime() : jNow) : '';
        const liveAttr = (isRunning && ab.startedAt) ? ' data-live-start="' + esc(ab.startedAt) + '"' : '';
        const heroJobLink = ab.jobUrl
          ? '<a href="' + esc(ab.jobUrl) + '" target="_blank" rel="noopener noreferrer" class="build-job-link" onclick="event.stopPropagation()">🔗 Job ↗</a>'
          : '';
        return '<div class="build-card ' + esc(st) + '" data-session-key="' + esc(s.session_key) + '">' +
          '<div class="row" style="justify-content:space-between;align-items:center">' +
            '<span class="build-badge ' + esc(st) + '">' + labelBuildStatus(st) + '</span>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              heroJobLink +
              '<span class="proj-pill">' + esc(s.machine) + ' · ' + esc(s.project_name || 'proyek') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="build-target">' + esc(ab.target) + '</div>' +
          renderBuildLocation(ab, s.machine) +
          flowChipHtml(s) +
          (ab.stage ? '<div class="build-stage">▸ ' + esc(ab.stage) + (hasPct ? ' (' + pct + '%)' : '') + '</div>' : '') +
          '<div class="' + barCls + '"><i style="width:' + pct + '%"></i></div>' +
          (ab.command ? '<div class="build-cmd">$ ' + esc(ab.command) + '</div>' : '') +
          (ab.output ? '<div class="event-out-box" style="margin-top:6px">' + esc(ab.output) + '</div>' : '') +
          '<div class="row" style="justify-content:space-between;margin-top:6px">' +
            '<span class="meta">' + esc(s.task || '') + '</span>' +
            (elapsed ? '<span class="meta" style="color:#79c0ff;font-weight:600"' + liveAttr + '>⏱ ' + esc(elapsed) + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
  '</div>';
}

let lastData = null;
let lastSessions = [];
let lastNow = Date.now();
let currentTab = 'aktif';
let currentFilter = 'semua';
let activeDetailKey = null;
let eventFilter = 'all';
let eventsCollapsed = false;

function setEventFilter(filter) {
  eventFilter = filter;
  const btnAll = document.getElementById('filter-all-events');
  const btnBuild = document.getElementById('filter-build-events');
  if (btnAll) btnAll.classList.toggle('active', filter === 'all');
  if (btnBuild) btnBuild.classList.toggle('active', filter === 'build');
  if (lastData) {
    const jNow = lastData.now ? new Date(lastData.now).getTime() : Date.now();
    renderEventsList(lastData.events || [], jNow);
  }
}

function toggleEventsCollapse() {
  eventsCollapsed = !eventsCollapsed;
  const c = document.getElementById('events-scroll-container');
  const btn = document.getElementById('btn-toggle-events');
  if (c) c.style.display = eventsCollapsed ? 'none' : 'block';
  if (btn) btn.textContent = eventsCollapsed ? 'Tampilkan' : 'Sembunyikan';
}

function parseClientEventDetail(detail) {
  if (!detail) return { isBuild: false, data: null, text: '' };
  if (typeof detail === 'object') {
    const isBuild = Boolean(detail.target || detail.command || detail.stage || detail.buildHost || detail.status || detail.progress !== undefined || detail.output);
    return { isBuild, data: isBuild ? detail : null, text: detail.output || detail.stage || detail.target || JSON.stringify(detail) };
  }
  const str = String(detail).trim();
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object') {
        const isBuild = Boolean(obj.target || obj.command || obj.stage || obj.buildHost || obj.status || obj.progress !== undefined || obj.output);
        return { isBuild, data: isBuild ? obj : null, text: obj.output || obj.stage || obj.target || str };
      }
    } catch (_) {}
  }
  return { isBuild: false, data: null, text: str };
}

function renderEventCard(e, jNow) {
  const parsed = parseClientEventDetail(e.detail);
  const timeStr = e.at ? ago(e.at, jNow) : '';
  const proj = esc(e.project_name || 'proyek');
  const kind = esc(e.kind || 'event');

  if (parsed.isBuild && parsed.data) {
    const b = parsed.data;
    const rawSt = String(b.status || (e.kind.includes('succeeded') ? 'succeeded' : e.kind.includes('failed') ? 'failed' : 'building')).toLowerCase();
    const st = (rawSt === 'building' || rawSt === 'testing' || rawSt === 'scanning' || rawSt === 'deploying' || rawSt === 'succeeded' || rawSt === 'failed') ? rawSt : 'building';
    const stLabel = st === 'succeeded' ? 'BERHASIL' : st === 'failed' ? 'GAGAL' : st === 'building' ? 'BUILDING' : st === 'testing' ? 'TESTING' : st.toUpperCase();
    const host = b.buildHost ? esc(b.buildHost) : (e.machine ? esc(e.machine) : '');
    const target = esc(b.target || e.project_name || 'Build Target');
    const stage = b.stage ? esc(b.stage) : '';
    const progress = (typeof b.progress === 'number' && isFinite(b.progress)) ? Math.max(0, Math.min(100, Math.round(b.progress))) : null;
    const cmd = b.command ? esc(b.command) : '';
    const out = b.output ? esc(b.output) : '';

    return '<div class="event-card build ' + esc(st) + '">' +
      '<div class="event-head">' +
        '<div class="event-title-line">' +
          '<span class="build-badge ' + esc(st) + '" style="font-size:10px;padding:1px 7px">' + stLabel + '</span>' +
          '<span class="event-target-text">' + target + '</span>' +
        '</div>' +
        '<div class="event-meta-line">' +
          (host ? '<span class="event-host-pill">🖥️ ' + host + '</span>' : '') +
          '<span style="color:#c9d1d9">' + proj + '</span>' +
          (timeStr ? '<span>· ' + timeStr + '</span>' : '') +
        '</div>' +
      '</div>' +
      (stage ? '<div class="event-stage-line">▸ ' + stage + (progress !== null ? ' (' + progress + '%)' : '') + '</div>' : '') +
      (progress !== null ? '<div class="build-bar" style="margin:4px 0 6px;height:4px"><i style="width:' + progress + '%"></i></div>' : '') +
      (cmd ? '<div class="event-cmd-box">$ ' + cmd + '</div>' : '') +
      (out ? '<div class="event-out-box">' + out + '</div>' : '') +
    '</div>';
  }

  // Non-build or generic events
  return '<div class="event-card generic">' +
    '<div class="event-head">' +
      '<div class="event-title-line">' +
        '<span class="event-kind-tag">' + kind + '</span>' +
        '<span class="event-detail-text">' + esc(parsed.text) + '</span>' +
      '</div>' +
      '<div class="event-meta-line">' +
        (e.machine ? '<span>' + esc(e.machine) + ' · </span>' : '') +
        '<span style="color:#c9d1d9">' + proj + '</span>' +
        (timeStr ? '<span>· ' + timeStr + '</span>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderEventsList(events, jNow) {
  const el = document.getElementById('events');
  if (!el) return;
  const badgeEl = document.getElementById('events-count-badge');

  const allEvents = events || [];
  const buildEvents = allEvents.filter(function(e) {
    const k = String(e.kind || '');
    if (k.startsWith('build_') || k === 'tests_passed' || k === 'tests_failed' || k === 'release') return true;
    const p = parseClientEventDetail(e.detail);
    return p.isBuild;
  });

  if (badgeEl) {
    badgeEl.textContent = allEvents.length + ' aktivitas · ' + buildEvents.length + ' build';
  }

  const filtered = eventFilter === 'build' ? buildEvents : allEvents;
  if (!filtered.length) {
    el.innerHTML = '<div class="empty" style="padding:20px 0;font-size:12px">' +
      (eventFilter === 'build' ? 'belum ada log build tercatat' : 'belum ada aktivitas tercatat') + '</div>';
    return;
  }

  el.innerHTML = filtered.map(function(e) { return renderEventCard(e, jNow); }).join('');
}

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
    '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' + agentText + '</span>' + versionPill(s);

  document.getElementById('modal-task').textContent = s.task || s.session_title || '(tanpa task)';
  document.getElementById('modal-task-metadata').innerHTML = renderTaskMetadata(s) + flowChipHtml(s);
  document.getElementById('modal-session-title').textContent = s.session_title ? '💬 ' + s.session_title : '';
  document.getElementById('modal-project').textContent = s.project_name || '';
  document.getElementById('modal-meta').textContent =
    esc(s.machine) + (s.task_type ? ' · ' + s.task_type : '') + ' · ' + ago(s.updated_at, jNow);
  document.getElementById('modal-path').innerHTML =
    (repoLinkHtml(s) ? '<div style="margin-bottom:2px">' + repoLinkHtml(s) + '</div>' : '') +
    esc(s.project_path || '');

  const t = durasi(s.started_at, jNow);
  const timerEl = document.getElementById('modal-timer');
  if (t) {
    timerEl.innerHTML = '<span class="timer-badge">⏱ berjalan ' + esc(t) + '</span>' + renderPipeline(s);
  } else {
    timerEl.innerHTML = renderPipeline(s);
  }

  const buildModalEl = document.getElementById('modal-build');
  if (buildModalEl) {
    buildModalEl.innerHTML = (s.active_build
      ? '<div class="modal-sec-title">Status Build &amp; Eksekusi</div>' + renderBuildBox(s.active_build, jNow, s.machine)
      : '') + renderRefinementHistory(s);
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
    closeBtn.disabled = false;
    closeBtn.textContent = '✕ Tutup Sesi';
    closeBtn.style.background = '';
    closeBtn.style.color = '';
    closeBtn.style.borderColor = '';
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

var currentFlowData = { id: '', title: '', url: '' };

function openFlowModal(id, title, url) {
  currentFlowData = { id: String(id || ''), title: title || ('Draw #' + id), url: url || '' };
  var modal = document.getElementById('modal-flow');
  var titleEl = document.getElementById('modal-flow-title');
  var imgEl = document.getElementById('modal-flow-img');
  var linkEl = document.getElementById('modal-flow-link');
  var loadingEl = document.getElementById('modal-flow-loading');

  if (titleEl) titleEl.textContent = currentFlowData.title;
  if (linkEl) {
    linkEl.href = currentFlowData.url || ('https://zettly.programinglive.com/draw/' + id);
  }
  if (loadingEl) {
    loadingEl.style.display = 'block';
    loadingEl.textContent = 'Memuat diagram flow...';
  }
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.onload = function() {
      if (loadingEl) loadingEl.style.display = 'none';
      imgEl.style.display = 'block';
    };
    imgEl.onerror = function() {
      if (loadingEl) loadingEl.textContent = 'Gagal memuat preview diagram.';
    };
    imgEl.src = '/api/drawings/' + encodeURIComponent(id) + '/thumbnail?t=' + Date.now();
  }
  if (modal) modal.style.display = 'flex';
}

function tutupFlowModal() {
  var modal = document.getElementById('modal-flow');
  if (modal) modal.style.display = 'none';
}

function unduhFlowPng() {
  var imgEl = document.getElementById('modal-flow-img');
  if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
  try {
    var canvas = document.createElement('canvas');
    var w = imgEl.naturalWidth || 680;
    var h = imgEl.naturalHeight || 600;
    canvas.width = w * 2;
    canvas.height = h * 2;
    var ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(imgEl, 0, 0, w, h);
    var a = document.createElement('a');
    a.download = (currentFlowData.title || 'flow-diagram').replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  } catch (err) {
    console.error('Download PNG failed:', err);
  }
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
      versionPill(h) +
      '<span class="task">' + esc(h.task || h.session_title || '(tanpa task)') + '</span></div>' +
      renderTaskMetadata(h) +
      flowChipHtml(h) +
      renderChain(h) +      '<div class="meta" style="margin-top:4px">' + esc(h.machine) +
      (h.project_name ? ' · ' + esc(h.project_name) : '') +
      (h.duration_label ? ' · ⏱ ' + esc(h.duration_label) : ' · durasi tidak tercatat') +
      ' · ' + ago(h.updated_at, jNow) + '</div>' +
      '<div class="detail-hint">ketuk untuk detail ›</div>' +
      '</div>';
  }).join('');
}

function render(data) {
  lastData = data;
  lastSessions = visibleTaskSessions(data.sessions);
  lastNow = data.now ? new Date(data.now).getTime() : Date.now();
  const activeSessions = visibleTaskSessions(data.sessions);
  const jNow = data.now ? new Date(data.now).getTime() : Date.now();
  document.getElementById('sub').textContent =
    activeSessions.length + ' task · ' + new Date(jNow).toLocaleTimeString('id-ID');

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
  const buildingNowCount = activeSessions.filter(function(s) {
    const st = s.active_build && String(s.active_build.status || '').toLowerCase();
    return st === 'building' || st === 'testing' || st === 'scanning' || st === 'deploying';
  }).length;
  const kpiEl = document.getElementById('kpi-strip');
  if (kpiEl) {
    const onlineMachines = (data.machines || []).filter(function(m) { return !m.stale; }).length;
    kpiEl.innerHTML =
      '<div class="kpi-card"><span class="kpi-lbl">⚡ Task Aktif</span><span class="kpi-val">' + activeSessions.length + '</span><span class="kpi-sub">sesi sedang berjalan</span></div>' +
      '<div class="kpi-card' + (buildingNowCount > 0 ? ' building-active' : '') + '"><span class="kpi-lbl">🏗️ Sedang Build / Test</span><span class="kpi-val" style="color:' + (buildingNowCount > 0 ? '#f0c674' : '#e6edf3') + '">' + buildingNowCount + '</span><span class="kpi-sub">' + (buildingNowCount > 0 ? 'proses build aktif' : 'tidak ada build aktif') + '</span></div>' +
      '<div class="kpi-card"><span class="kpi-lbl">🖥️ Mesin Terhubung</span><span class="kpi-val">' + onlineMachines + '/' + (data.machines || []).length + '</span><span class="kpi-sub">' + (function() {
        const f = data.fleet;
        if (!f || !(f.machines || []).length) return 'aktif melapor';
        if ((f.mismatched || []).length) return 'versi menyimpang di ' + f.mismatched.length + ' mesin';
        if ((f.unreported || []).length) return (f.version ? 'versi ' + f.version : 'versi belum bulat') + ' · ' + f.unreported.length + ' belum melapor';
        return 'versi ' + (f.version || '-') + ' sama di semua';
      })() + '</span></div>' +
      '<div class="kpi-card"><span class="kpi-lbl">✅ Riwayat (7 Hari)</span><span class="kpi-val" style="color:#3fb950">' + (data.history || []).length + '</span><span class="kpi-sub">sesi tercatat</span></div>';
  }

  renderBuildMonitor(activeSessions, jNow);

  if (!activeSessions.length) {
    list.innerHTML = '<div class="empty">belum ada task aktif; koneksi device tercatat di tab Mesin</div>';
  } else {
    list.innerHTML = activeSessions.map(s => {
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
      const durText = durasi(s.started_at, jNow);

      return '<div class="card clickable-card ' + cardCls + '" data-session-key="' + esc(s.session_key) + '">' +
        '<div class="row"><span class="' + chipCls + '">' + chipText + '</span>' +
        '<span class="phase" style="background:#a371f71a;color:#d2a8ff;border-color:#a371f755">' +
        esc(String(s.agent_tool || 'unknown').toUpperCase()) + '</span>' +
        versionPill(s) +
        (s.project_name ? '<span class="proj-pill">' + esc(s.project_name) + '</span>' : '') +
        (durText ? '<span class="meta" style="margin-left:auto;color:#79c0ff">⏱ ' + esc(durText) + '</span>' : '') +
        '</div>' +
        '<div class="task" style="margin-top:6px">' + esc(s.task || s.session_title || '(tanpa task)') + '</div>' +
        renderTaskMetadata(s) +
        renderChain(s) +
        (s.session_title ? '<div class="meta" style="color:#79c0ff;margin-top:2px">💬 ' + esc(s.session_title) + '</div>' : '') +
        note +
        '<div class="meta" style="margin-top:3px">' + esc(s.machine) + ' · ' + esc(s.project_name) +
        ' · ' + esc(s.task_type) + ' · ' + ago(s.updated_at, jNow) + '</div>' +
        (repoLinkHtml(s) ? '<div style="margin-top:3px">' + repoLinkHtml(s) + '</div>' : '') +
        renderPipeline(s) +
        renderBuildBox(s.active_build, jNow, s.machine) +
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
  // Kesamaan armada. Pertanyaan pemilik, 10 Nov 2026: "apakah versinya sudah
  // sama semua, apakah MCP-nya sama dan aktif semua, apakah cmd yang dibutuhkan
  // sudah sama semua". Kartu ringkas di atas, lalu satu baris alat per mesin.
  const fleet = data.fleet || { machines: [], tools: [], version: null, revision: null, mismatched: [], unreported: [] };
  const parityByMachine = {};
  (fleet.machines || []).forEach(function(p) { parityByMachine[p.machine] = p; });
  const expectedByTool = {};
  (fleet.tools || []).forEach(function(t) { expectedByTool[t.name] = t.expected; });

  function toolChip(name, actual) {
    var expected = expectedByTool[name];
    var colour = '#8b949e';
    var text = name + ' ?';
    if (actual === null) { colour = '#f85149'; text = name + ' ✕'; }
    else if (actual) {
      colour = (expected && actual !== expected) ? '#d29922' : '#3fb950';
      text = name + ' ' + actual;
    }
    return '<span title="' + esc(name + (expected ? ' · mayoritas ' + expected : '')) + '" style="color:' + colour +
      ';border:1px solid ' + colour + '55;background:' + colour + '14;border-radius:999px;padding:1px 7px;font-size:11px">' +
      esc(text) + '</span>';
  }

  const parityHead = (fleet.machines || []).length
    ? '<div class="card" style="border-color:#1f6feb55;background:linear-gradient(135deg,#0d1724 0%,#0d131c 100%)">' +
        '<div class="row"><b>Kesamaan Armada</b>' +
        '<span class="meta" style="margin-left:auto">versi ' + esc(fleet.version || 'belum bulat') +
        ' · rev ' + esc(String(fleet.revision || '-').slice(0, 7)) + '</span></div>' +
        '<div class="meta" style="margin-top:6px">' +
          (fleet.mismatched.length
            ? '<span style="color:#d29922">⚠ ' + fleet.mismatched.length + ' mesin menyimpang: ' + esc(fleet.mismatched.join(', ')) + '</span>'
            : '<span style="color:#3fb950">✓ versi sama di semua mesin yang melapor</span>') +
          (fleet.unreported.length
            ? ' · <span style="color:#8b949e">' + fleet.unreported.length + ' belum melapor lengkap: ' + esc(fleet.unreported.join(', ')) + '</span>'
            : '') +
        '</div>' +
        ((fleet.tools || []).length
          ? '<div class="meta" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">' +
              fleet.tools.map(function(t) { return toolChip(t.name, t.expected); }).join('') + '</div>'
          : '') +
      '</div>'
    : '';

  document.getElementById('machines').innerHTML = parityHead + ((data.machines || []).map(function(m) {
    const p = parityByMachine[m.machine] || null;
    const vState = !p ? 'versi ?'
      : p.versionStatus === 'same' ? 'versi sama'
      : p.versionStatus === 'differs' ? 'versi beda' : 'versi ?';
    const tState = !p ? 'alat ?'
      : p.toolsStatus === 'same' ? 'alat sama'
      : p.toolsStatus === 'differs' ? 'alat beda' : 'alat belum dilapor';
    const statusColour = !p ? '#8b949e'
      : (p.versionStatus === 'differs' || p.toolsStatus === 'differs') ? '#d29922'
      : p.status === 'in-sync' ? '#3fb950' : '#8b949e';
    const toolNames = (fleet.tools || []).map(function(t) { return t.name; });
    const chips = toolNames.map(function(name) {
      var actual = p && p.toolchain && Object.prototype.hasOwnProperty.call(p.toolchain, name) ? p.toolchain[name] : undefined;
      return toolChip(name, actual === undefined ? undefined : actual);
    }).join('');
    const drift = (p && p.driftedTools && p.driftedTools.length)
      ? '<div class="meta" style="margin-top:4px;color:#d29922">beda versi: ' + esc(p.driftedTools.join(', ')) + '</div>' : '';
    const missing = (p && p.missingTools && p.missingTools.length)
      ? '<div class="meta" style="margin-top:4px;color:#f85149">tidak terpasang: ' + esc(p.missingTools.join(', ')) + '</div>' : '';

    return '<div class="card"><div class="row"><b style="color:' + (m.stale ? '#d29922' : '#3fb950') + '">' + (m.stale ? '⚠ ' : '● ') + '</b> ' +
    '<b>' + esc(m.machine) + '</b>' +
    '<span class="meta" style="margin-left:auto">' + esc(p && p.version ? 'v' + p.version : 'versi ?') +
    ' · <span style="color:' + statusColour + '">' + vState + ' · ' + tState + '</span></span></div>' +
    '<div class="meta" style="margin-top:4px">' + m.sessions + ' sesi · fase terakhir ' + esc(m.last_phase || '-') +
    (m.last_project ? ' · ' + esc(m.last_project) : '') +
    (m.stale ? ' · sudah lama tidak melapor' : ' · terakhir melapor ' + ago(m.last_seen, jNow)) + '</div>' +
    (chips ? '<div class="meta" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">' + chips + '</div>' : '') +
    drift + missing + '</div>';
  }).join('') || '<div class="empty">belum ada mesin terhubung</div>');

  // Events
  renderEventsList(data.events || [], jNow);

  // Info
  const serverEl = document.getElementById('serverInfo');
  if (serverEl) {
    serverEl.innerHTML =
      '<b>URL:</b> ' + esc(window.location.origin) + '<br>' +
      '<b>Status:</b> ' + activeSessions.length + ' task aktif · ' + (data.history || []).length + ' riwayat · ' + (data.machines || []).length + ' mesin<br>' +
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
  // The ETA and the Build tab read the same report the MCP tool reads, so a
  // human and an agent never see different numbers. Failure here must not stop
  // the session view: the previous report simply stays on screen.
  try {
    const br = await fetch('/api/builds/report?days=30', { cache: 'no-store' });
    if (br.ok) {
      window.__buildReport = await br.json();
      renderBuildTab(window.__buildReport);
      renderBuildMonitor(lastSessions, lastNow);
    }
  } catch (e) { /* keep the last known report */ }
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
document.getElementById('build-monitor').addEventListener('click', function (e) {
  // The build card carries a flow chip too, and this handler used to only look
  // for the card itself, so a chip there did nothing at all.
  var flowBtn = e.target.closest('[data-flow-id]');
  if (flowBtn) {
    openFlowModal(flowBtn.dataset.flowId, flowBtn.dataset.flowTitle, flowBtn.dataset.flowUrl);
    return;
  }
  var card = e.target.closest('[data-session-key]');
  if (card) {
    bukaDetail(card.dataset.sessionKey);
  }
});
document.getElementById('list').addEventListener('click', function (e) {
  if (e.target.closest('a[href]')) return;
  var flowBtn = e.target.closest('[data-flow-id]');
  if (flowBtn) {
    openFlowModal(flowBtn.dataset.flowId, flowBtn.dataset.flowTitle, flowBtn.dataset.flowUrl);
    return;
  }
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
  if (e.target.closest('a[href]')) return;
  var flowBtn = e.target.closest('[data-flow-id]');
  if (flowBtn) {
    openFlowModal(flowBtn.dataset.flowId, flowBtn.dataset.flowTitle, flowBtn.dataset.flowUrl);
    return;
  }
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
  var flowBtn = e.target.closest('[data-flow-id]');
  if (flowBtn) {
    openFlowModal(flowBtn.dataset.flowId, flowBtn.dataset.flowTitle, flowBtn.dataset.flowUrl);
    return;
  }
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

var modalFlow = document.getElementById('modal-flow');
if (modalFlow) {
  modalFlow.addEventListener('click', function (e) {
    if (e.target.closest('#modal-flow-png-btn')) {
      unduhFlowPng();
      return;
    }
    if (e.target.matches('#modal-flow-backdrop') || e.target.closest('#modal-flow-close-btn') || e.target.closest('#modal-flow-tutup-btn')) {
      tutupFlowModal();
    }
  });
}

document.getElementById('tautan').addEventListener('click', function (e) {
  var t = e.target.closest('[data-copy],[data-revoke],[data-revoke-orphans]');
  if (!t) return;
  if (t.dataset.revokeOrphans) { void cabutYatim(t); }
  else if (t.dataset.copy) { void tombolSalin(t.dataset.copy, t); }
  else if (t.dataset.revoke) { void tombolCabut(t.dataset.revoke, t); }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    tutupModal();
    tutupFlowModal();
  }
});

// Handler tombol "Tutup Sesi" (force-close sesi macet dari dashboard)
document.addEventListener('click', async function(e) {
  var btn = e.target.closest('#modal-close-session-btn');
  if (!btn) return;
  var sessionKey = btn.dataset.sessionKey;
  if (!sessionKey) return;
  if (!confirm('Yakin ingin menutup paksa sesi ini?\\n' + sessionKey + '\\n\\nSesi akan diset ke phase "closed".')) return;
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
setInterval(function () {
  var nodes = document.querySelectorAll('[data-live-start]');
  var nowMs = Date.now();
  nodes.forEach(function (el) {
    var iso = el.getAttribute('data-live-start');
    if (iso) {
      el.textContent = '⏱ ' + durasiDetik(iso, nowMs);
    }
  });
}, 1000);
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
  /*
   * Junk sessions are never CREATED.
   *
   * OWNER INSTRUCTION (10 November 2026): a session with no title cannot be
   * used in a report, so treat it as junk and make sure it does not happen
   * again.
   *
   * WHY THIS CHECK IS HERE AND NOT IN buildSessionUpsert
   * ----------------------------------------------------
   * A sparse report for an ALREADY EXISTING session is legitimate: closing a
   * task sends an empty task on purpose so the row keeps its identity and its
   * relations (see the COALESCE guards in the upsert). Refusing that shape in
   * the SQL builder would break closing a task. The junk case is specifically a
   * row that would be CREATED with nothing in it, so this asks whether the row
   * already exists first.
   *
   * A report with a task, a title OR a project still creates a row: a card that
   * only has a title is something a human can recognise.
   */
  const key = str(body.cardKey || body.sessionKey, 200);
  const taskId = str(body.taskId, 200);
  if (key) {
    const existing = await query(
      `SELECT 1 FROM sessions WHERE session_key = $1 AND task_id = $2 LIMIT 1`,
      [key, taskId],
    );
    if (shouldSkipCreate(body, existing.rowCount > 0)) {
      // Nothing to report and no row to preserve: do not create one.
      return key;
    }
  }

  const { sql, params } = buildSessionUpsert(body);
  await query(sql, params);
  // Kartu yang digantikan oleh kartu baru dalam sesi yang sama dihentikan:
  // sesinya masih hidup, tetapi topik itu sudah pindah. Tanpa ini kartu lama
  // tampil "berjalan" selamanya di tab Aktif.
  const handoff = buildParentHandoff(body);
  if (handoff) await query(handoff.sql, handoff.params);
  // Kunci build per KARTU, bukan per sesi. Sebelumnya satu build bocor ke
  // topik berikutnya di sesi yang sama dan membuat kartu baru tampak bekerja
  // padahal tidak pernah memulainya.
  const buildKey = cardKey(key, taskId);
  if (body && body.activeBuild && typeof body.activeBuild === 'object') {
    liveBuildsBySession.set(buildKey, { taskId, build: normalizeBuildState(body.activeBuild) });
  } else if (body && (body.phase === 'idle' || body.phase === 'closed' || body.phase === 'done' || body.phase === 'handed-off')) {
    liveBuildsBySession.delete(buildKey);
  }

  return key;
}

async function insertEvent(body) {
  const kind = str(body.kind, 80);
  if (!kind) throw new Error('kind wajib');
  const sessionKey = str(body.sessionKey, 200);
  let storedDetail = str(body.detail, 1000);
  if (kind.startsWith('build_') && body.detail) {
    try {
      const parsed = JSON.parse(String(body.detail));
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizeBuildState(parsed);
        const completeDetail = JSON.stringify(normalized);
        if (completeDetail.length <= 12000) {
          storedDetail = completeDetail;
          if (sessionKey) liveBuildsBySession.set(sessionKey, normalized);
        }
      }
    } catch {}
  }
  await query(
    `INSERT INTO events (session_key, machine, project_name, kind, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [sessionKey, str(body.machine, 120), str(body.projectName, 160),
     kind, storedDetail]);
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
    // Mobile Companion QR Device Pairing (M2)
    if (url.pathname === '/api/v1/mobile/pair/verify') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-device-token');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST') {
        const pairingEngine = await getPairingEngine();
        if (!pairingEngine) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Pairing engine unavailable' }));
        }
        const body = bacaJson(await readBody(req), res);
        if (body === null) return undefined;
        const result = await handlePairVerify({ body, pairingEngine });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result.body));
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    }
    if (url.pathname === '/api/v1/mobile/pair/status') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {
        const pairingEngine = await getPairingEngine();
        if (!pairingEngine) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Pairing engine unavailable' }));
        }
        const result = await handlePairStatus({ queryParams: url.searchParams, pairingEngine });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result.body));
      }
      res.writeHead(405, { 'content-type': 'application/json' });
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
    const drawingMatch = /^\/api\/drawings\/(\d+)\/thumbnail(\.png)?$/.exec(url.pathname);
    if (drawingMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const drawingId = Number(drawingMatch[1]);
      const wantsPng = Boolean(drawingMatch[2]);
      // Logged because "the image does not appear" is otherwise unanswerable:
      // the browser and the tablet hit the same route and only one of them
      // fails, and without the caller address there is no way to tell which.
      console.log(`[drawing] ${req.method} ${url.pathname}${url.search} from ${req.socket.remoteAddress} ua=${String(req.headers['user-agent'] || '').slice(0, 60)}`);
      if (!Number.isSafeInteger(drawingId) || drawingId < 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid drawing id' }));
      }
      try {
        const row = await fetchDrawing(drawingId);
        if (!row || !row.thumbnail) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'drawing thumbnail not found' }));
        }
        const svg = drawingSvg(row.thumbnail);

        if (wantsPng) {
          const png = await renderDrawingPng(drawingId, svg);
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=3600',
          });
          if (req.method === 'HEAD') return res.end();
          return res.end(png);
        }

        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(svg);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'failed to fetch drawing: ' + err.message }));
      }
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
        `SELECT at, session_key, kind, detail, project_name, machine
           FROM events ORDER BY at DESC LIMIT 20`);
      const eventBuilds = extractActiveBuildFromEvents(events.rows);
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
      const machines = visibleMachines(machineRows.rows);
      // Kesamaan armada: apakah semua mesin menjalankan rilis dan alat yang
      // sama. Dihitung dari baris mesin yang SUDAH ditampilkan, jadi angkanya
      // tidak bisa berbeda dengan yang dilihat pemilik di layar.
      const fleet = buildFleetParity(machines);
      // Riwayat sesi SELESAI. Durasi dihitung database supaya sama di semua
      // perangkat, dan tidak ada data yang dihapus.
      const hq = buildHistoryQuery({ historyDays: HISTORY_DAYS });
      // Waktu acuan untuk menurunkan status, dipakai kartu aktif DAN riwayat.
      const nowMs = Date.now();
      const historyRows = await query(hq.sql, hq.params);
      const historyKeys = historyRows.rows.map((r) => r.session_key).filter(Boolean);
      const historyBuildRows = historyKeys.length ? await query(
        `SELECT DISTINCT ON (session_key) at, session_key, kind, detail, project_name, machine
           FROM events
          WHERE session_key = ANY($1::text[])
            AND (kind LIKE 'build_%' OR kind IN ('tests_passed', 'tests_failed', 'release'))
          ORDER BY session_key, at DESC`,
        [historyKeys],
      ) : { rows: [] };
      const historyBuilds = extractActiveBuildFromEvents(historyBuildRows.rows);
      const historyBase = historyRows.rows.map((r) => {
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
      // Peristiwa build tidak membawa task id, jadi build dari riwayat hanya
      // boleh melekat ke kartu TERBARU sebuah sesi (baris pertama, karena
      // query mengurutkan updated_at DESC). Kalau tidak, build kartu baru
      // bocor ke kartu lama yang sudah handed-off.
      // Rantai Zettelkasten: kartu lama jarang masih ada di tab Aktif, jadi
      // arah "dilanjutkan ke" dibaca dari daftar riwayat yang memuat keduanya.
      const sesiTerlihatRiwayat = new Set();
      const history = historyBase.map((row) => {
        const kartuTerbaru = !sesiTerlihatRiwayat.has(row.session_key);
        sesiTerlihatRiwayat.add(row.session_key);
        const { from, to } = chainLabels(row, historyBase);
        return {
          ...row,
          active_build: kartuTerbaru ? (historyBuilds.get(row.session_key) || null) : null,
          chain_from: from,
          chain_to: to,
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
      // Kartu-kartu dikelompokkan per sesi saat menentukan pemilik build.
      const sesiTerlihat = new Set();
      const rows = sessions.rows.map((row) => {
        const s = classifySession({
          phase: row.phase,
          updatedAt: row.updated_at,
          now: nowMs,
          liveMs: LIVE_MS,
          stuckMs: STUCK_MS,
        });
        // Kartu terbaru sebuah sesi = baris pertama, karena query mengurutkan
        // updated_at DESC. Build dari event tidak membawa task id, jadi hanya
        // kartu terbaru yang boleh memakainya; kalau tidak, build lama bocor
        // ke kartu berikutnya.
        const terbaru = !sesiTerlihat.has(row.session_key);
        sesiTerlihat.add(row.session_key);
        let activeBuild = buildForCard(liveBuildsBySession.get(cardKey(row.session_key, row.task_id)), row);
        if (!activeBuild && terbaru) {
          activeBuild =
            eventBuilds.get(row.session_key) ||
            (row.machine && row.project_name ? eventBuilds.get(`${row.machine}::${row.project_name}`) : null) ||
            null;
        }
        if (activeBuild && row.started_at) {
          const buildTime = new Date(activeBuild.updatedAt || activeBuild.startedAt).getTime();
          const taskTime = new Date(row.started_at).getTime();
          if (buildTime < taskTime) activeBuild = null;
        }
        if (!activeBuild && s.status === 'live' && (row.phase === 'testing' || row.phase === 'release')) {
          const rencana = Array.isArray(row.plan_json) ? row.plan_json : [];
          const openStep = rencana.find((p) => p && p.status !== 'done');
          activeBuild = normalizeBuildState({
            status: row.phase === 'release' ? 'deploying' : 'testing',
            target: row.project_name || row.task || 'Active Build / Test',
            stage: openStep ? openStep.text : `Running ${row.phase} phase`,
            progress: row.plan_total ? Math.round((Number(row.plan_done || 0) / Number(row.plan_total)) * 100) : null,
            startedAt: row.updated_at || row.started_at,
            updatedAt: row.updated_at,
          });
        }
        return { ...withRepoLink(row), state: s.status, state_label: LABELS[s.status] || s.status, active_build: activeBuild };
      });
      // Tautan rantai untuk kartu aktif. Arah "dilanjutkan ke" biasanya kosong
      // di sini karena kartu lama sudah handed-off dan hanya ada di riwayat.
      const bersambung = rows.map((row) => {
        const { from, to } = chainLabels(row, rows);
        return from || to ? { ...row, chain_from: from, chain_to: to } : row;
      });
      // Buang kartu kembar (mesin + task sama) sebelum dikirim ke layar.
      const tampil = dedupeSessions(bersambung);
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
        machines,
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
        JSON.stringify({ now: serverNow, sessions: tampil, events: events.rows, health, machines, fleet, history, alerts, summary, shares, summary_days: SUMMARY_DAYS }),
      );
    }
    if (url.pathname === '/api/builds/report') {
      // Duration report for the build box and the Build tab. Read-only, and the
      // window is clamped inside buildReportQuery to the event retention.
      const days = Number(url.searchParams.get('days') || 30);
      const project = url.searchParams.get('project');
      const host = url.searchParams.get('host');
      const { sql, params } = buildReportQuery({ days, project, host });
      const rows = await query(sql, params);
      const payload = buildReportPayload(rows.rows, {
        days: Number(params[0]),
        now: new Date().toISOString(),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(payload));
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

/**
 * Repository identity columns.
 *
 * Added after the first deployment, so the running database needs a migration.
 * `IF NOT EXISTS` keeps the boot idempotent. A database user without ALTER
 * rights prints the SQL instead of taking the dashboard down.
 */
const ensureSessionRepositoryColumnsSql = `
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_path text NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_remote text NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refinement_json jsonb;
`;

/**
 * Apply the repository columns only when they are missing.
 *
 * The dashboard runs as the application user, which does not own the table.
 * Checking first keeps a healthy deployment quiet; only a real gap prints the
 * SQL the operator must run as the table owner.
 */
async function ensureSessionRepositoryColumns() {
  const existing = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sessions'
        AND column_name IN ('repo_path', 'repo_remote', 'refinement_json')`,
  );
  // All three, not two: the check used to stop at the repository columns, so a
  // database that already had them never received refinement_json and every
  // session query failed with "column does not exist".
  if (existing.rows.length >= 3) return;
  await query(ensureSessionRepositoryColumnsSql);
}

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
    try {
      await ensureSessionRepositoryColumns();
    } catch (error) {
      console.error('GAGAL menyiapkan kolom repository:', String((error && error.message) || error));
      console.error('Jalankan sekali sebagai user database aplikasi:\n' + ensureSessionRepositoryColumnsSql);
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



