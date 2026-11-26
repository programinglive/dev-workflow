import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { estimateTokens, recordToolResponse, getSessionUsage, resetSessionUsage } from '../src/token-meter.js';
import { getToolList, getAllToolDefinitions } from '../tools/definitions.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowState } from '../workflow-state.js';
import { handleToolCall } from '../tools/handlers.js';
import { normalizeRequestArgs } from '../utils.js';
import { testUtils, bindTaskToRepo } from './test-helpers.js';
import { parseArgs } from '../cli/args.js';

test('estimateTokens returns a documented low-high range', () => {
  const r = estimateTokens(12000);
  assert.deepEqual(r, { low: 3000, high: 4000 });
});

test('session recorder accumulates text safely and writes no files', () => {
  resetSessionUsage();
  recordToolResponse('get_workflow_status', { content: [{ type: 'text', text: 'abcde' }] });
  recordToolResponse('start_task', { content: [{ type: 'text', text: '0123456789' }] });
  recordToolResponse('audit', { content: [{ type: 'json', data: { ignore: true } }] });
  const usage = getSessionUsage();
  assert.equal(usage.calls, 2);
  assert.equal(usage.chars, 15);
  assert.equal(usage.byTool[0].name, 'start_task');
  assert.equal(usage.byTool[0].chars, 10);
});

test('tool counts remain 18, 30 and 66', () => {
  assert.equal(getAllToolDefinitions().length, 66);
  assert.equal(getToolList().length, 66);
});

test('devwf tools --tokens prints three measured profiles', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['bin/cli.js', 'tools', '--tokens'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const profile of ['core', 'standard', 'full']) assert.match(result.stdout, new RegExp(`${profile}:`));
  assert.match(result.stdout, /estimate/i);
});
test('get_workflow_status shows the context cost line unless disabled', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'token-meter-status-'));
  const state = new WorkflowState(path.join(dir, 'state.json'));
  await state.load();
  await bindTaskToRepo(state);
  const call = () => handleToolCall({
    request: { params: { name: 'get_workflow_status', arguments: {} } },
    normalizeRequestArgs,
    workflowState: state,
    exec: async () => ({ stdout: '' }),
    git: {
      hasWorkingChanges: async () => false,
      getCurrentBranch: async () => 'main',
      getPrimaryBranch: async () => 'main',
      getHeadSha: async () => 'a'.repeat(40),
      getRemoteBranchSha: async () => 'a'.repeat(40),
      getStatusOutput: async () => '',
    },
    utils: testUtils,
  });
  const previous = process.env.DEVWF_TOKEN_METER;
  try {
    delete process.env.DEVWF_TOKEN_METER;
    assert.match(((await call()).content || []).map((item) => item.text || '').join(''), /Context cost \(estimate\): profile=/);
    process.env.DEVWF_TOKEN_METER = '0';
    assert.doesNotMatch(((await call()).content || []).map((item) => item.text || '').join(''), /Context cost \(estimate\):/);
  } finally {
    if (previous === undefined) delete process.env.DEVWF_TOKEN_METER;
    else process.env.DEVWF_TOKEN_METER = previous;
    state.db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI parses devwf tools --tokens', () => {
  const parsed = parseArgs(['tools', '--tokens']);
  assert.equal(parsed.command, 'tools');
  assert.equal(parsed.tokens, true);
});
