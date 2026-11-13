import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const dashboard = readFileSync(new URL('../monitor-server/dashboard.cjs', import.meta.url), 'utf8');
const { normalizeTaskMetadata, renderTaskMetadata } = require('../monitor-server/task-metadata.cjs');
  const { estimateBuild } = require('../monitor-server/build-report.cjs');
const { visibleTaskSessions } = require('../monitor-server/visible-task-sessions.cjs');

test('renderTaskMetadata outputs flow preview container and thumbnail for zettly_draw relation', () => {
  const relations = [
    { system: 'zettly', id: '302', url: 'https://zettly.programinglive.com/todos/302', label: 'Zettly #302', relation: 'tracks' },
    { system: 'zettly_draw', id: '37', url: 'https://zettly.programinglive.com/draw/37', label: 'Draw #37', relation: 'visual_plan' },
  ];
  const html = renderTaskMetadata({
    workflow_task_id: 'wf-test-flow',
    task_origin_json: { system: 'manual', label: 'Direct request' },
    task_relations_json: relations,
  });

  assert.match(html, /flow-preview/);
  assert.match(html, /data-flow-id="37"/);
  assert.match(html, /\/api\/drawings\/37\/thumbnail/);
  assert.match(html, /Flow Diagram/);
  assert.match(html, /https:\/\/zettly\.programinglive\.com\/draw\/37/);
});

test('dashboard PAGE HTML contains modal-flow dialog with preview and PNG export buttons', () => {
  assert.ok(dashboard.includes('id="modal-flow"'), 'dashboard has modal-flow element');
  assert.ok(dashboard.includes('id="modal-flow-img"'), 'dashboard has modal-flow-img element');
  assert.ok(dashboard.includes('id="modal-flow-png-btn"'), 'dashboard has download PNG button');
  assert.ok(dashboard.includes('id="modal-flow-link"'), 'dashboard has link to Zettly Draw');
});

test('served browser script contains openFlowModal, tutupFlowModal and unduhFlowPng functions', () => {
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
  const browser = vm.createContext({
    URL, console, window: { location: { host: 'monitor.test' } }, setInterval() {},
    fetch: () => new Promise(() => {}),
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
  });

  vm.runInContext(script, browser);

  assert.equal(typeof browser.openFlowModal, 'function', 'openFlowModal is defined in browser context');
  assert.equal(typeof browser.tutupFlowModal, 'function', 'tutupFlowModal is defined in browser context');
  assert.equal(typeof browser.unduhFlowPng, 'function', 'unduhFlowPng is defined in browser context');

  // Test opening the flow modal
  browser.openFlowModal('37', 'Dev Workflow Flow', 'https://zettly.programinglive.com/draw/37');
  assert.equal(node('modal-flow').style.display, 'flex');
  assert.equal(node('modal-flow-title').textContent, 'Dev Workflow Flow');
  assert.equal(node('modal-flow-link').href, 'https://zettly.programinglive.com/draw/37');

  // Test closing the flow modal
  browser.tutupFlowModal();
  assert.equal(node('modal-flow').style.display, 'none');
});

test('dashboard server script includes /api/drawings/:id/thumbnail route pattern', () => {
  assert.ok(dashboard.includes('/api/drawings/'), 'dashboard handles /api/drawings/ endpoint');
  assert.ok(dashboard.includes('thumbnail'), 'dashboard handles thumbnail');
  assert.match(dashboard, /content-type': 'image\/svg\+xml/);
});
