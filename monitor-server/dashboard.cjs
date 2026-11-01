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

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const DB_URL = process.env.DATABASE_URL || '';
const POLL_MS = 3000;
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
</style></head><body>
<h1>Dev Workflow Monitor</h1>
<div class="sub" id="sub">menyambung…</div>
<div id="list"><div class="empty">memuat…</div></div>
<h1 style="font-size:14px;margin-top:24px">Aktivitas terakhir</h1>
<div id="events" class="events"></div>
<script>
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 'd lalu';
  if (d < 3600) return Math.round(d/60) + 'm lalu';
  if (d < 86400) return Math.round(d/3600) + 'j lalu';
  return Math.round(d/86400) + 'h lalu';
}
function render(data) {
  document.getElementById('sub').textContent =
    data.sessions.length + ' sesi · ' + new Date().toLocaleTimeString('id-ID');
  const live = data.sessions.filter(s => s.phase !== 'idle').length;
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
      return '<div class="card ' + (s.phase !== 'idle' ? 'live' : '') + '">' +
        '<div class="row"><span class="phase">' + esc(s.phase) + '</span>' +
        '<span class="task">' + esc(s.task || '(tanpa task)') + '</span></div>' +
        '<div class="meta">' + esc(s.machine) + ' · ' + esc(s.project_name) +
        ' · ' + esc(s.task_type) + ' · ' + ago(s.updated_at) + '</div>' +
        (total ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="meta">rencana ' + done + '/' + total + ' · DoD ' + s.dod_done + '/' + s.dod_total +
          (s.dod_waived ? ' (' + s.dod_waived + ' dilewati)' : '') + '</div>' : '') +
        (plan ? '<ul>' + plan + '</ul>' : '') +
        '</div>';
    }).join('');
  }
  document.getElementById('events').innerHTML = (data.events || []).map(e =>
    '<div><b>' + esc(e.kind) + '</b> ' + esc(e.detail) +
    '<span class="meta"> · ' + esc(e.project_name) + ' · ' + ago(e.at) + '</span></div>').join('')
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
      const body = JSON.parse(await readBody(req) || '{}');
      const key = await upsertSession(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessionKey: key }));
    }
    if (url.pathname === '/api/event' && req.method === 'POST') {
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
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ sessions: sessions.rows, events: events.rows }));
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
});
