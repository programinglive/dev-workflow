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
const { classifySession, LABELS, DEFAULT_LIVE_MS, DEFAULT_STUCK_MS } = require('./status.cjs');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const DB_URL = process.env.DATABASE_URL || '';
const POLL_MS = 3000;
/**
 * Token bersama untuk endpoint TULIS.
 *
 * Membaca tetap bebas - dashboard harus terbuka tanpa login. Menulis tidak:
 * tanpa ini, perangkat mana pun di tailnet bisa mengirim sesi palsu ke layar
 * tablet. Kosong berarti SEMUA penulisan ditolak, bukan diterima.
 */
const WRITE_TOKEN = process.env.DEVWF_MONITOR_TOKEN || '';
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
</style></head><body>
<h1>Dev Workflow Monitor</h1>
<div class="sub" id="sub">menyambung…</div>
<div id="warn"></div>
<div id="list"><div class="empty">memuat…</div></div>
<h1 style="font-size:14px;margin-top:24px">Aktivitas terakhir</h1>
<div id="events" class="events"></div>
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
      return '<div class="card ' + cardCls + '">' +
        '<div class="row"><span class="' + chipCls + '">' + chipText + '</span>' +
        '<span class="task">' + esc(s.task || '(tanpa task)') + '</span></div>' +
        note +
        '<div class="meta">' + esc(s.machine) + ' · ' + esc(s.project_name) +
        ' · ' + esc(s.task_type) + ' · ' + ago(s.updated_at, jNow) + '</div>' +
        (total ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="meta">rencana ' + done + '/' + total + ' · DoD ' + s.dod_done + '/' + s.dod_total +
          (s.dod_waived ? ' (' + s.dod_waived + ' dilewati)' : '') + '</div>' : '') +
        (plan ? '<ul>' + plan + '</ul>' : '') +
        '</div>';
    }).join('');
  }
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
tick(); setInterval(tick, ${POLL_MS});
</script></body></html>`;

async function query(sql, params) {
  if (!pool) throw new Error('DATABASE_URL not set');
  return pool.query(sql, params);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
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
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

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
  const key = str(body.sessionKey, 200);
  if (!key) throw new Error('sessionKey wajib');
  const plan = Array.isArray(body.plan) ? body.plan.slice(0, 40) : [];
  await query(
    `INSERT INTO sessions (session_key, machine, project_path, project_name, task, task_type, phase,
                           plan_json, plan_done, plan_total, dod_done, dod_total, dod_waived,
                           owner_pid, started_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT (session_key) DO UPDATE SET
       machine=EXCLUDED.machine, project_path=EXCLUDED.project_path, project_name=EXCLUDED.project_name,
       task=EXCLUDED.task, task_type=EXCLUDED.task_type, phase=EXCLUDED.phase,
       plan_json=EXCLUDED.plan_json, plan_done=EXCLUDED.plan_done, plan_total=EXCLUDED.plan_total,
       dod_done=EXCLUDED.dod_done, dod_total=EXCLUDED.dod_total, dod_waived=EXCLUDED.dod_waived,
       owner_pid=EXCLUDED.owner_pid,
       started_at=COALESCE(sessions.started_at, EXCLUDED.started_at),
       updated_at=now()`,
    [key, str(body.machine, 120), str(body.projectPath, 512), str(body.projectName, 160),
     str(body.task, 500), str(body.taskType, 40), str(body.phase, 40),
     JSON.stringify(plan), int(body.planDone), int(body.planTotal),
     int(body.dodDone), int(body.dodTotal), int(body.dodWaived),
     body.ownerPid ? int(body.ownerPid) : null, body.startedAt || null]);
  return key;
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
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (!isWriteAuthorized({ header: req.headers.authorization, expectedToken: WRITE_TOKEN })) {
        return denyWrite(res);
      }
      const body = JSON.parse(await readBody(req) || '{}');
      const key = await upsertSession(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessionKey: key }));
    }
    if (url.pathname === '/api/event' && req.method === 'POST') {
      if (!isWriteAuthorized({ header: req.headers.authorization, expectedToken: WRITE_TOKEN })) {
        return denyWrite(res);
      }
      const body = JSON.parse(await readBody(req) || '{}');
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
      const nowMs = Date.now();
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
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ now: serverNow, sessions: rows, events: events.rows, health }));
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

