import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

import {buildSnapshot} from '../monitor.js';

const require = createRequire(import.meta.url);
const {buildSessionUpsert} = require('../monitor-server/session-upsert.cjs');

const DASHBOARD = readFileSync(new URL('../monitor-server/dashboard.cjs', import.meta.url), 'utf8');

/**
 * The monitor is supposed to answer "what did the AI actually do in this
 * session". These tests pin the three places that answer was lost: the
 * refinement history never left the state file, the flow diagram was never
 * rendered, and the build link had no URL to show.
 */

function stateWithRefinement(history) {
  return {
    currentPhase: 'coding',
    workflowTaskId: 'task-1',
    taskDescription: 'Fix checkout',
    plan: [],
    definitionOfDone: [],
    refinement: {
      revision: history.length,
      context: 'accumulated context',
      previousDescription: 'Fix checkout',
      updatedAt: '2026-11-12T00:00:00.000Z',
      history,
    },
  };
}

test('snapshot carries the refinement history to the monitor', () => {
  const snapshot = buildSnapshot({
    state: stateWithRefinement([
      {revision: 1, at: '2026-11-12T00:00:00.000Z', description: 'first', newContext: 'ctx one', plan: ['a'], definitionOfDone: ['b']},
      {revision: 2, at: '2026-11-12T00:10:00.000Z', description: 'second', newContext: 'ctx two', plan: ['a', 'c'], definitionOfDone: ['b']},
    ]),
    sessionKey: 'ses_test',
    projectPath: 'D:\\code\\demo',
  });

  assert.equal(snapshot.refinement.history.length, 2);
  assert.equal(snapshot.refinement.history[1].revision, 2);
  assert.equal(snapshot.refinement.history[1].newContext, 'ctx two');
});

test('snapshot bounds the history even when the state file is longer', () => {
  const history = Array.from({length: 25}, (_, index) => ({
    revision: index + 1,
    at: '2026-11-12T00:00:00.000Z',
    description: `revision ${index + 1}`,
    newContext: 'ctx',
    plan: [],
    definitionOfDone: [],
  }));

  const snapshot = buildSnapshot({state: stateWithRefinement(history), sessionKey: 'ses_test'});
  assert.equal(snapshot.refinement.history.length, 10);
  assert.equal(snapshot.refinement.history[9].revision, 25);
});

test('a session without refinement reports null instead of an empty object', () => {
  const snapshot = buildSnapshot({state: {currentPhase: 'coding'}, sessionKey: 'ses_test'});
  assert.equal(snapshot.refinement, null);
});

test('the upsert writes refinement_json and keeps the previous value when absent', () => {
  const withRefinement = buildSessionUpsert({
    sessionKey: 'ses_test',
    machine: 'HELLOWORLD',
    projectPath: 'D:\\code\\demo',
    projectName: 'demo',
    task: 'Fix checkout',
    refinement: {revision: 1, history: [{revision: 1, description: 'first'}]},
  });

  assert.match(withRefinement.sql, /refinement_json/);
  assert.match(withRefinement.sql, /refinement_json=COALESCE\(EXCLUDED\.refinement_json, sessions\.refinement_json\)/);
  assert.ok(withRefinement.params.some(value => typeof value === 'string' && value.includes('"revision":1')));

  const withoutRefinement = buildSessionUpsert({
    sessionKey: 'ses_test',
    machine: 'HELLOWORLD',
    projectPath: 'D:\\code\\demo',
    projectName: 'demo',
    task: 'Fix checkout',
  });
  assert.equal(withoutRefinement.params[withoutRefinement.params.length - 1], null);
});

test('the dashboard renders a flow button from the stored drawing relation', () => {
  assert.match(DASHBOARD, /function flowChipHtml/);
  assert.match(DASHBOARD, /data-flow-id=/);
  assert.match(DASHBOARD, /zettly_draw/);
  // The chip must actually be placed in the card and the detail modal, not just
  // defined: a helper nobody calls is the bug this test exists for.
  assert.ok(DASHBOARD.includes('flowChipHtml(h)'), 'history card must render the chip');
  assert.ok(DASHBOARD.includes('flowChipHtml(s)'), 'detail modal and build card must render the chip');
});

test('the dashboard renders the refinement history', () => {
  assert.match(DASHBOARD, /function renderRefinementHistory/);
  assert.match(DASHBOARD, /refinement_json/);
  assert.ok(DASHBOARD.includes('renderRefinementHistory(s)'), 'detail modal must render the history');
});

test('the build link shows the URL text, not only a label', () => {
  // The dashboard is a template literal, so a regex with escaped slashes would
  // be eaten before the browser sees it. String replaces keep it literal.
  assert.match(DASHBOARD, /validJobUrl\.replace\('https:\/\/', ''\)/);
});

test('the monitor serves a PNG copy for clients that cannot draw SVG', () => {
  // The tablet app uses React Native <Image>, which cannot render SVG, and asks
  // for /thumbnail.png. That route did not exist, so the flow was a 404 on the
  // device the owner actually carries.
  assert.match(DASHBOARD, /thumbnail\(\\\.png\)\?/);
  assert.match(DASHBOARD, /function renderDrawingPng/);
  assert.match(DASHBOARD, /'content-type': 'image\/png'/);
  assert.match(DASHBOARD, /require\('sharp'\)/);
});
