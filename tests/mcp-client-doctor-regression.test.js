import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MCP_CLIENT_STATUSES,
  redactDiagnosticObject,
  safeParseJson,
  computeToolCatalogDigest,
  getClientConfigCandidates,
  inspectConfigFile,
  diagnoseClient,
  diagnoseAllClients,
} = require('../managed/mcp-client-doctor.cjs');

test('mcp-client-doctor: safeParseJson handles comments and trailing commas', () => {
  const jsonWithComments = `
    // Configuration file
    {
      /* Multi-line comment */
      "mcpServers": {
        "dev-workflow": {
          "command": "node",
          "args": ["entry.cjs"], // inline comment
        },
      },
    }
  `;
  const parsed = safeParseJson(jsonWithComments);
  assert.ok(parsed);
  assert.equal(parsed.mcpServers['dev-workflow'].command, 'node');
  assert.deepEqual(parsed.mcpServers['dev-workflow'].args, ['entry.cjs']);

  assert.equal(safeParseJson('{ bad json'), null);
  assert.equal(safeParseJson(null), null);
});

test('mcp-client-doctor: redactDiagnosticObject scrubs credentials and secrets', () => {
  const rawData = {
    machine: 'MMCH',
    client: 'opencode',
    DEVWF_MONITOR_TOKEN: 'secret-token-value-12345',
    api_key: 'super-secret-key',
    password: 'my-password',
    authSecret: 'bearer-token-abc',
    nested: {
      credentials: {
        database_password: 'pg-password',
      },
      url: 'https://user:password123@internal.domain/mcp',
      safeEndpoint: 'http://127.0.0.1:3100',
    },
  };

  const redacted = redactDiagnosticObject(rawData);
  assert.equal(redacted.DEVWF_MONITOR_TOKEN, '[REDACTED]');
  assert.equal(redacted.api_key, '[REDACTED]');
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.authSecret, '[REDACTED]');
  assert.equal(redacted.nested.credentials.database_password, '[REDACTED]');
  assert.equal(redacted.nested.url, 'https://[REDACTED]@internal.domain/mcp');
  assert.equal(redacted.nested.safeEndpoint, 'http://127.0.0.1:3100');
  assert.equal(redacted.machine, 'MMCH');
});

test('mcp-client-doctor: detects CONFIG_EMPTY for 0-byte file (reproducing MMCH AGY incident)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devwf-doctor-test-'));
  try {
    const geminiConfigDir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(geminiConfigDir, { recursive: true });
    const emptyConfig = path.join(geminiConfigDir, 'mcp_config.json');
    fs.writeFileSync(emptyConfig, ''); // 0 bytes

    const report = diagnoseClient({
      client: 'antigravity-cli',
      home: tmpHome,
      machine: 'TEST-HOST',
    });

    assert.equal(report.status, MCP_CLIENT_STATUSES.CONFIG_EMPTY);
    assert.equal(report.configFile, emptyConfig);
    assert.equal(report.bootstrapResolves, false);
    assert.match(report.remediation, /agy mcp add/i);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('mcp-client-doctor: detects CONFIG_INVALID on corrupt JSON syntax', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devwf-doctor-test-'));
  try {
    const opencodeDir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const badConfig = path.join(opencodeDir, 'opencode.json');
    fs.writeFileSync(badConfig, '{"mcp": { corrupted');

    const report = diagnoseClient({
      client: 'opencode',
      home: tmpHome,
      machine: 'TEST-HOST',
    });

    assert.equal(report.status, MCP_CLIENT_STATUSES.CONFIG_INVALID);
    assert.equal(report.configFile, badConfig);
    assert.match(report.remediation, /syntax errors/i);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('mcp-client-doctor: detects REGISTRATION_MISSING when file is valid but dev-workflow is absent', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devwf-doctor-test-'));
  try {
    const geminiDir = path.join(tmpHome, '.gemini', 'antigravity');
    fs.mkdirSync(geminiDir, { recursive: true });
    const validOtherMcp = path.join(geminiDir, 'mcp_config.json');
    fs.writeFileSync(
      validOtherMcp,
      JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } })
    );

    const report = diagnoseClient({
      client: 'antigravity',
      home: tmpHome,
      machine: 'TEST-HOST',
    });

    assert.equal(report.status, MCP_CLIENT_STATUSES.REGISTRATION_MISSING);
    assert.equal(report.configFile, validOtherMcp);
    assert.match(report.remediation, /Add \[dev-workflow\] MCP server/i);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('mcp-client-doctor: detects NOT_INSTALLED vs CONFIG_MISSING correctly', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devwf-doctor-test-'));
  try {
    // Non-existent directory -> NOT_INSTALLED
    const notInstalled = diagnoseClient({
      client: 'codex',
      home: tmpHome,
      machine: 'TEST-HOST',
    });
    assert.equal(notInstalled.status, MCP_CLIENT_STATUSES.NOT_INSTALLED);

    // Parent directory exists but config missing -> CONFIG_MISSING
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const configMissing = diagnoseClient({
      client: 'codex',
      home: tmpHome,
      machine: 'TEST-HOST',
    });
    assert.equal(configMissing.status, MCP_CLIENT_STATUSES.CONFIG_MISSING);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('mcp-client-doctor: computeToolCatalogDigest is deterministic and sorted', () => {
  const digestA = computeToolCatalogDigest(['start_task', 'get_workflow_status', 'complete_task']);
  const digestB = computeToolCatalogDigest(['complete_task', 'start_task', 'get_workflow_status']);
  assert.equal(digestA, digestB);
  assert.equal(digestA.length, 16);
});

test('mcp-client-doctor: diagnoseAllClients aggregates all supported clients', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devwf-doctor-test-'));
  try {
    const report = diagnoseAllClients({ home: tmpHome, machine: 'TEST-HOST' });
    assert.equal(report.machine, 'TEST-HOST');
    assert.equal(report.clients.length, 4);
    const clientNames = report.clients.map((c) => c.client);
    assert.deepEqual(clientNames.sort(), ['antigravity', 'antigravity-cli', 'codex', 'opencode']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
