import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, '..', 'index.js');

/**
 * Normal startup must not be logged at level "error".
 *
 * WHY: `MCP Server starting...`, `Workflow state initialization complete.`,
 * `Connecting transport...` and `running on stdio` were all written with
 * safeLog('error', ...). The MCP is healthy, but every start produced four
 * `{"level":"error"}` lines, so the operator read a working process as a
 * failed one. Only a genuine failure may use the error level.
 */
test('startup progress is logged at info, not error', async () => {
  const source = await fs.readFile(indexPath, 'utf8');

  const informational = [
    'MCP Server starting...',
    'Workflow state initialization complete.',
    'Connecting transport...',
    'Dev Workflow MCP Server running on stdio',
  ];

  for (const message of informational) {
    const line = source
      .split('\n')
      .find((candidate) => candidate.includes(message) && candidate.includes('safeLog'));

    assert.ok(line, `could not find the log line for "${message}"`);
    assert.ok(
      !line.includes("safeLog('error'"),
      `"${message}" is normal startup progress and must not be logged at error level`,
    );
  }
});

test('a genuine initialization failure still logs at error', async () => {
  const source = await fs.readFile(indexPath, 'utf8');

  const line = source
    .split('\n')
    .find((candidate) => candidate.includes('Failed to initialize workflow state'));

  assert.ok(line, 'the failure branch must still exist');
  assert.ok(
    line.includes("safeLog('error'"),
    'a real initialization failure must keep the error level',
  );
});
