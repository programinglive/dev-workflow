#!/usr/bin/env node
import { safeLog } from '../security/sanitizer.js';

/**
 * Verifies that the built bundle actually starts.
 *
 * `npm run build:server` succeeding only means the bundler emitted a file. It
 * says nothing about whether that file runs. This bit us with vite 8: the build
 * was green and smaller, but `node dist/index.mjs` threw
 *
 *   Calling `require` for "fs" in an environment that doesn't expose the
 *   `require` function
 *
 * because rolldown's CJS shim assumed CommonJS. CI only ran the build, so a
 * broken artefact would have shipped.
 *
 * The MCP server is a stdio server: it exits cleanly when stdin closes. So the
 * pass condition is the startup banner, not the exit code - the same rule used
 * by scripts/setup-stack.js and the release workflow.
 *
 * Usage: node scripts/verify-bundle.mjs [dist/index.mjs]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const entry = path.resolve(process.argv[2] || 'dist/index.mjs');
const STARTUP_PATTERN = /running on stdio|MCP Server starting/i;
const TIMEOUT_MS = 15000;

if (!existsSync(entry)) {
  safeLog('error', `✖ Bundle not found: ${entry}`);
  safeLog('error', '  Run "npm run build:server" first.');
  process.exit(1);
}

safeLog('info', `Verifying ${path.relative(process.cwd(), entry)}`);

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let settled = false;

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

function finish(ok, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    child.kill();
  } catch {
    // already gone
  }

  const output = `${stdout}${stderr}`;
  if (ok) {
    safeLog('info', `✓ ${reason}`);
    process.exit(0);
  }

  safeLog('error', `✖ ${reason}`);
  safeLog('error', '--- bundle output ---');
  safeLog('error', output.trim() || '(no output)');
  process.exit(1);
}

child.on('error', (error) => finish(false, `Failed to spawn: ${error.message}`));

child.on('exit', (code) => {
  if (STARTUP_PATTERN.test(`${stdout}${stderr}`)) {
    finish(true, 'Bundle started and exited cleanly (stdin closed).');
  } else {
    finish(false, `Bundle exited with code ${code} without reporting that it started.`);
  }
});

const timer = setTimeout(() => {
  if (STARTUP_PATTERN.test(`${stdout}${stderr}`)) {
    finish(true, 'Bundle started and stayed alive.');
  } else {
    finish(false, `Bundle produced no startup output within ${TIMEOUT_MS}ms.`);
  }
}, TIMEOUT_MS);
