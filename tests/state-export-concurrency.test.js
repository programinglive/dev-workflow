import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkflowState } from '../workflow-state.js';

/**
 * Two exports of the same state file must not collide on a shared temp name.
 *
 * WHY: the temp name was `${stateFile}.tmp-${pid}`, so two concurrent exports
 * inside one MCP process wrote the same file. One rename won and the other
 * failed with ENOENT, which the operator saw as a warning on every startup.
 * The state itself stayed safe in SQLite, but the log made a healthy process
 * look broken.
 */
test('concurrent exports of one state file do not collide', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devwf-export-'));
  const stateFile = path.join(dir, 'nested', 'workflow-state.json');

  const state = new WorkflowState(stateFile);

  const results = await Promise.all([
    state._exportJson(),
    state._exportJson(),
    state._exportJson(),
  ]);

  assert.deepEqual(results, [true, true, true], 'every export must succeed');

  const written = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.ok(written && typeof written === 'object', 'the export must be valid JSON');

  const leftovers = (await fs.readdir(path.dirname(stateFile))).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temp file may be left behind');
});
