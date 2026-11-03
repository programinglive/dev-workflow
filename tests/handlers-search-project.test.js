import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleToolCall } from '../tools/handlers.js';
import { getToolList } from '../tools/definitions.js';
import { createGitMock, createRequest, testUtils, withWorkflowState } from './test-helpers.js';

async function makeRepo(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-search-handler-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'search-test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Search Test']);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixtures']);
  return root;
}

async function callSearch(workflowState, args) {
  return handleToolCall({
    request: createRequest('search_project', args),
    normalizeRequestArgs: (input) => ({ args: input, error: null }),
    workflowState,
    exec: async () => ({ stdout: '' }),
    git: createGitMock(),
    utils: testUtils,
  });
}

describe('search_project MCP tool', () => {
  it('registers a query and bounded result limit without a caller-supplied path', () => {
    const tool = getToolList().find(({ name }) => name === 'search_project');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['query']);
    assert.ok(tool.inputSchema.properties.query);
    assert.ok(tool.inputSchema.properties.limit);
    assert.equal(tool.inputSchema.properties.path, undefined);
  });

  it('searches the pinned project and returns sanitized path-and-line citations', async () => {
    const root = await makeRepo({ 'src/app.js': 'first\nworkflow search works\n' });
    try {
      await withWorkflowState(async (workflowState) => {
        workflowState.state.projectDir = root;
        const response = await callSearch(workflowState, { query: 'workflow search', projectDir: path.parse(root).root });
        const text = response.content[0].text;
        assert.match(text, /src\/app\.js:2/u);
        assert.match(text, /workflow search works/u);
        assert.doesNotMatch(text, /C:\\|D:\\/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the workflow has no pinned project', async () => {
    await withWorkflowState(async (workflowState) => {
      workflowState.state.projectDir = '';
      const response = await callSearch(workflowState, { query: 'anything' });
      assert.match(response.content[0].text, /active project|project directory|repository/iu);
    });
  });

  it('redacts credential material in otherwise searchable source lines', async () => {
    const root = await makeRepo({ 'src/config.js': 'const access = "AKIA1234567890ABCDEF"; // workflow search\n' });
    try {
      await withWorkflowState(async (workflowState) => {
        workflowState.state.projectDir = root;
        const response = await callSearch(workflowState, { query: 'workflow search' });
        assert.doesNotMatch(response.content[0].text, /AKIA1234567890ABCDEF/u);
        assert.match(response.content[0].text, /REDACTED/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid limit with a clear safe response', async () => {
    const root = await makeRepo({ 'README.md': 'needle\n' });
    try {
      await withWorkflowState(async (workflowState) => {
        workflowState.state.projectDir = root;
        const response = await callSearch(workflowState, { query: 'needle', limit: 99 });
        assert.match(response.content[0].text, /limit/i);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


