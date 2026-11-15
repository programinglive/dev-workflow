import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSessionUpsert } = require('../monitor-server/session-upsert.cjs');
const dashboard = readFileSync(new URL('../monitor-server/dashboard.cjs', import.meta.url), 'utf8');

const origin = { system: 'factory', id: 'F-7', url: 'https://factory.example/tasks/F-7', label: 'Printer repair' };
const relations = [
  { system: 'zettly', id: 'Z-2', url: 'https://zettly.example/todos/Z-2', label: 'Tracking Todo', relation: 'tracks' },
  { system: 'sentry', id: '91', url: 'https://sentry.io/organizations/test/issues/91/', label: 'Error', relation: 'reports' },
];

test('sparse completion preserves provenance while a new workflow ID or task title resets it', () => {
  // Execute the upsert locally. Only PostgreSQL casts and clock/min/max functions
  // need adapting; CASE/ON CONFLICT and preservation conditions run unchanged.
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.function('now', () => '2026-11-04');
  db.function('LEAST', { varargs: true }, (...values) => values.filter(v => v !== null).sort()[0] ?? null);
  db.function('GREATEST', { varargs: true }, (...values) => values.filter(v => v !== null).sort().at(-1) ?? null);
  // Mirror the production schema after migrations 001/002/003: the composite
  // primary key (session_key, task_id) plus the task-metadata columns.
  db.exec(`CREATE TABLE sessions (
    session_key TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '',
    machine TEXT, project_path TEXT, project_name TEXT,
    task TEXT, task_type TEXT, phase TEXT, plan_json TEXT, plan_done INTEGER,
    plan_total INTEGER, dod_done INTEGER, dod_total INTEGER, dod_waived INTEGER,
    owner_pid INTEGER, started_at TEXT, session_title TEXT, agent_tool TEXT, updated_at TEXT,
    workflow_task_id TEXT DEFAULT '', task_origin_json TEXT DEFAULT '{}', task_relations_json TEXT DEFAULT '[]',
    repo_path TEXT DEFAULT '', repo_remote TEXT DEFAULT '',
    release_version TEXT DEFAULT '', release_revision TEXT DEFAULT '',
    toolchain_json TEXT DEFAULT '{}',
    refinement_json TEXT,
    owner_started_at TEXT DEFAULT '', owner_executable TEXT DEFAULT '',
    lease_owner TEXT DEFAULT '', lease_generation INTEGER DEFAULT 0, lease_fencing_token TEXT DEFAULT '',
    parent_task_id TEXT, parent_task_title TEXT,
    PRIMARY KEY (session_key, task_id)
  )`);
  const save = body => {
    const { sql, params } = buildSessionUpsert({ sessionKey: 's', ...body });
    db.prepare(sql.replace(/::jsonb/g, '').replace(/\$(\d+)/g, ':p$1'))
      .run(Object.fromEntries(params.map((value, index) => ['p' + (index + 1), value])));
    return db.prepare('SELECT * FROM sessions').get();
  };
  try {
    save({ task: 'Repair', workflowTaskId: 'wf-1', taskOrigin: origin, taskRelations: relations });
    const completed = save({ task: '', phase: 'idle' });
    assert.equal(completed.workflow_task_id, 'wf-1');
    assert.deepEqual(JSON.parse(completed.task_origin_json), origin);
    assert.deepEqual(JSON.parse(completed.task_relations_json), relations);
    const next = save({ task: 'Other task', workflowTaskId: 'wf-2' });
    assert.equal(next.workflow_task_id, 'wf-2');
    assert.deepEqual(JSON.parse(next.task_origin_json), {});
    assert.deepEqual(JSON.parse(next.task_relations_json), []);
    save({ task: 'Other task', workflowTaskId: 'wf-2', taskOrigin: origin, taskRelations: relations });
    const renamed = save({ task: 'Unrelated manual task' });
    assert.equal(renamed.workflow_task_id, '');
    assert.deepEqual(JSON.parse(renamed.task_origin_json), {});
    assert.deepEqual(JSON.parse(renamed.task_relations_json), []);
    save({ task: 'New initial task', workflowTaskId: 'wf-3', taskOrigin: origin, taskRelations: relations });
    const same = save({ workflowTaskId: 'wf-3', task: '', taskOrigin: { system: 'unknown' }, taskRelations: [] });
    assert.deepEqual(JSON.parse(same.task_origin_json), origin);
    assert.deepEqual(JSON.parse(same.task_relations_json), relations);
    const manual = save({ task: 'Manual task after completion' });
    assert.equal(manual.workflow_task_id, '');
    assert.deepEqual(JSON.parse(manual.task_origin_json), {});
    assert.deepEqual(JSON.parse(manual.task_relations_json), []);
  } finally { db.close(); }
});

test('upsert carries distinct workflow identity, initial origin and all service relations', () => {
  const { params } = buildSessionUpsert({ sessionKey: 's', task: 'Repair', workflowTaskId: 'wf-1', taskOrigin: origin, taskRelations: relations });
  assert.equal(params[17], 'wf-1');
  assert.deepEqual(JSON.parse(params[18]), origin);
  assert.deepEqual(JSON.parse(params[19]), relations);
});

test('legacy snapshots do not infer a Zettly origin from a Todo', () => {
  const { params } = buildSessionUpsert({ sessionKey: 's', zettlyTodoId: 'Z-2' });
  assert.equal(params[17], '');
  assert.deepEqual(JSON.parse(params[18]), {});
  assert.deepEqual(JSON.parse(params[19]), []);
});

test('metadata is bounded and unsafe URL schemes, credentials and secret query strings are removed', () => {
  const { params } = buildSessionUpsert({ sessionKey: 's', workflowTaskId: 'x'.repeat(1000),
    taskOrigin: { ...origin, url: 'javascript:alert(1)' },
    taskRelations: [
      ...['javascript:alert(1)', 'https://user:password@evil.example/a', 'https://zettly.example/a?token=secret', 'file:///a'].map((url, index) => ({ ...relations[0], id: 'unsafe-' + index, url })),
      { ...relations[0], system: 'other' },
      ...Array.from({ length: 100 }, (_, i) => ({ ...relations[0], id: String(i), label: 'a'.repeat(2000) })),
    ] });
  assert.ok(params[17].length <= 200);
  assert.equal(JSON.parse(params[18]).url, '');
  const saved = JSON.parse(params[19]);
  assert.ok(saved.length <= 64);
  assert.ok(saved.every(r => r.label.length <= 200));
  assert.ok(saved.slice(0, 4).every(r => r.url === ''));
  assert.ok(saved.every(r => r.system === 'zettly'));
});

test('dashboard renders explicit origin separately from every relation with IDs and safe links', () => {
  const context = { require, URL, console, process: { env: {} } };
  vm.createContext(context);
  // Execute the real renderer embedded in the browser script without a DOM or server.
  const { normalizeTaskMetadata, renderTaskMetadata } = require('../monitor-server/task-metadata.cjs');
  const { estimateBuild } = require('../monitor-server/build-report.cjs');
  vm.runInContext(normalizeTaskMetadata.toString() + '\n' + renderTaskMetadata.toString(), context);
  const html = context.renderTaskMetadata({ workflow_task_id: 'wf-1', task_origin_json: origin, task_relations_json: relations });
  assert.match(html.replace(/<[^>]*>/g, ''), /Source: Factory/);
  assert.match(html, /F-7/);
  assert.match(html, /Relations:/);
  assert.match(html, /Zettly.*Z-2/);
  assert.match(html, /Sentry.*91/);
  for (const record of [origin, ...relations]) assert.ok(html.includes('href="' + record.url + '"'));
  assert.match(html, /rel="noopener noreferrer"/);
  const legacy = context.renderTaskMetadata({ zettly_todo_id: 'Z-2', task_relations_json: relations });
  assert.match(legacy, /Source: Unknown/);
  const drawing=context.renderTaskMetadata({task_relations_json:[{system:'zettly_draw',id:'5',url:'https://zettly.programinglive.com/draw/5',label:'Draw #5',relation:'visual_plan'}]});
  assert.match(drawing,/Zettly Draw/);assert.match(drawing,/task-relation-zettly_draw/);
  assert.ok(!drawing.includes('Draw #5 · Draw #5'));
  assert.doesNotMatch(legacy, /Source: Zettly/);
  const malicious = context.renderTaskMetadata({ task_origin_json: { ...origin, id: '<script>', url: 'javascript:alert(1)' },
    task_relations_json: [{ ...relations[0], url: 'https://user:secret@example.com/a', label: '<img onerror=alert(1)>' }] });
  assert.doesNotMatch(malicious, /javascript:|user:secret|<script>|<img/);
  assert.match(malicious, /&lt;script&gt;/);
});

test('served browser script displays metadata on cards, history and detail and anchor clicks bypass the modal', () => {
  const { normalizeTaskMetadata, renderTaskMetadata } = require('../monitor-server/task-metadata.cjs');
  const { estimateBuild } = require('../monitor-server/build-report.cjs');
  const { visibleTaskSessions } = require('../monitor-server/visible-task-sessions.cjs');
  const pageContext = vm.createContext({ normalizeTaskMetadata, renderTaskMetadata, visibleTaskSessions, estimateBuild, POLL_MS: 3000 });
  const pageExpression = dashboard.slice(dashboard.indexOf('const PAGE = '), dashboard.indexOf('async function query('));
  const page = vm.runInContext(pageExpression + '\nPAGE', pageContext);
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, dataset: {},
      classList: { toggle() {} }, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } });
    return nodes.get(id);
  };
  const browser = vm.createContext({ URL, console, window: { location: { host: 'monitor.test' } }, setInterval() {},
    fetch: () => new Promise(() => {}),
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} } });
  vm.runInContext(script, browser);
  const session = { session_key: 's', project_name: 'printer-erp', task: 'Repair', task_origin_json: origin, task_relations_json: relations,
    phase: 'coding', state: 'live', machine: 'TEST', updated_at: '2026-11-04T00:00:00Z' };
  browser.render({ now: '2026-11-04T00:00:00Z', sessions: [session], history: [session] });
  browser.bukaDetail('s');
  for (const id of ['list', 'history', 'modal-task-metadata']) {
    const html = node(id).innerHTML;
    assert.match(html.replace(/<[^>]*>/g, ''), /Source: Factory/);
    for (const record of [origin, ...relations]) {
      assert.ok(html.includes(record.id), id + ' shows the service ID');
      assert.ok(html.includes('href="' + record.url + '"'), id + ' shows the service link');
    }
  }
  for (const id of ['list', 'history']) {
    node('modal-detail').style.display = 'none';
    node(id).listeners.click({ target: { closest: selector => selector === 'a[href]' ? {} : { dataset: { sessionKey: 's' } } } });
    assert.equal(node('modal-detail').style.display, 'none');
  }
});
