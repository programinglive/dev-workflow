#!/usr/bin/env node
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { safeLog } from '../security/sanitizer.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

const entry = path.resolve(process.argv[2] || 'dist/index.mjs');
const TIMEOUT_MS = 15_000;

if (!existsSync(entry)) {
  safeLog('error', `✖ Bundle not found: ${entry}`);
  safeLog('error', '  Run "npm run build:server" first.');
  process.exit(1);
}

safeLog('info', `Verifying MCP runtime in ${path.relative(process.cwd(), entry)}`);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'devwf-bundle-verifier-'));
const projectDir = path.join(tempRoot, 'synthetic-project');
const statePin = path.join(tempRoot, 'state', 'workflow-state.json');
let transport;
let stderrOutput = '';
let nextId = 0;

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), TIMEOUT_MS);
    transport.onmessage = (message) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || `${method} failed`));
      else resolve(message);
    };
    transport.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    transport.send({ jsonrpc: '2.0', id, method, params });
  });
}

try {
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await mkdir(path.dirname(statePin), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'workflow.js'), 'bundle-verifier-needle\n');
  await writeFile(statePin, JSON.stringify({ projectDir, currentPhase: 'idle' }));
  execFileSync('git', ['-C', projectDir, 'init', '-q']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'bundle-verifier@example.invalid']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Bundle Verifier']);
  execFileSync('git', ['-C', projectDir, 'add', 'src/workflow.js']);
  execFileSync('git', ['-C', projectDir, 'commit', '-qm', 'bundle fixture']);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: projectDir,
    env: {
      DEV_WORKFLOW_STATE_FILE: statePin,
      DEV_WORKFLOW_SESSION_ID: 'bundle-verifier-isolated-session',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderrOutput += chunk.toString(); });
  await transport.start();

  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bundle-verifier', version: '1.0.0' },
  });
  if (!initialized.result?.protocolVersion) throw new Error('Bundle did not complete MCP initialize');
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listing = await request('tools/list', {});
  if (!listing.result?.tools?.some((tool) => tool.name === 'search_project')) {
    throw new Error('MCP tools/list did not include search_project');
  }

  const call = await request('tools/call', {
    name: 'search_project',
    arguments: { query: 'bundle-verifier-needle', limit: 1 },
  });
  const text = call.result?.content?.map((item) => item.text || '').join('\n') || '';
  if (!text.includes('src/workflow.js:1') || !text.includes('bundle-verifier-needle')) {
    throw new Error(`search_project did not return the isolated fixture citation: ${text || '(empty response)'}`);
  }
  safeLog('info', '✓ Bundle initialized, listed search_project, and returned the isolated path:line citation.');
} catch (error) {
  safeLog('error', `✖ ${error.message || String(error)}`);
  if (stderrOutput.trim()) safeLog('error', stderrOutput.trim());
  process.exitCode = 1;
} finally {
  await transport?.close();
  await rm(tempRoot, { recursive: true, force: true });
}