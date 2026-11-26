import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUserConfig } from '../src/user-config.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

test('user config defaults are empty and an external file can override them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-user-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ slugs: { demo: { slug: 'demo', repo_full_name: 'owner/demo' } } }));
  const previous = process.env.DWF_TEST_CONFIG;
  try {
    delete process.env.DWF_TEST_CONFIG;
    assert.deepEqual(loadUserConfig('DWF_TEST_CONFIG', 'config/repo-slug-map.json', ROOT), { slugs: {} });
    process.env.DWF_TEST_CONFIG = file;
    const loaded = loadUserConfig('DWF_TEST_CONFIG', 'config/repo-slug-map.json', ROOT);
    assert.equal(loaded.slugs.demo.slug, 'demo');
  } finally {
    if (previous === undefined) delete process.env.DWF_TEST_CONFIG;
    else process.env.DWF_TEST_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('product code no longer hardcodes organisation data or a monitor IP', () => {
  const files = [
    'mcp-index.js',
    'src/zettly-code-adapter.js',
    'scripts/session-reaper.cjs',
  ];
  const patterns = [
    /clinic-helper/i,
    /beautyworld/i,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  ];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of patterns) assert.equal(re.test(content), false, `${rel} still contains hardcoded organisation data`);
  }
});

test('optional MCP index data comes from configuration, not product code', async () => {
  const { MCP_ECOSYSTEM_INDEX } = await import('../mcp-index.js');
  assert.equal(MCP_ECOSYSTEM_INDEX.some(server => /clinic/i.test(server.id || '')), false);
});
