/**
 * The publisher and the launcher must both carry the version.
 *
 * publish.cjs writes current.json, launcher.cjs stores it in last-good.json and
 * exports it to the server. A gap at either end makes the version invisible
 * again even though protocol.cjs accepts it.
 *
 * Run: node --test tests/managed-version-plumbing.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const managedSrc = process.env.MANAGED_SRC || join(process.cwd(), 'managed');

test('publish.cjs reads the version from the published commit, not the working tree', () => {
  const source = readFileSync(join(managedSrc, 'publish.cjs'), 'utf8');
  assert.match(source, /git',\['show',revision\+':package\.json'\]/, 'version must come from the archived commit');
  assert.match(source, /const manifest=\{revision,sha256,size:body\.length,version\}/, 'manifest must include version');
  assert.match(source, /if\(typeof version!=='string'\|\|!version\.trim\(\)\)/, 'an empty version must abort the publish');
});

test('launcher exports the version to the running server', () => {
  const source = readFileSync(join(managedSrc, 'launcher.cjs'), 'utf8');
  assert.match(source, /DEVWF_RELEASE_VERSION:release\.version/, 'the child process needs the version in its environment');
  assert.match(source, /release\.version\?' \('\+release\.version\+'\)'/, 'the startup line should name the version when known');
});

test('resolveRelease keeps the version from the served manifest', async () => {
  const { resolveRelease } = require(join(managedSrc, 'launcher.cjs'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'managed-resolve-'));
  const revision = 'a'.repeat(40);
  const sha = 'b'.repeat(64);
  const runtimeKey = [process.platform, process.arch, process.versions.modules].join('-');
  const runtimeRoot = join(cacheRoot, 'releases', `${sha}-${runtimeKey}`);

  try {
    // An already-installed release whose marker matches, so no archive download
    // happens; only the manifest path is exercised.
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'index.js'), '// installed\n');
    await writeFile(join(runtimeRoot, '.managed-verified.json'),
      JSON.stringify({ revision, sha256: sha, size: 1, runtimeKey }));
    await writeFile(join(cacheRoot, 'last-good.json'),
      JSON.stringify({ revision, sha256: sha, size: 1, version: '3.4.5' }));

    const release = await resolveRelease({
      url: 'http://127.0.0.1:9',
      token: 'test-token-long-enough',
      cacheRoot,
      fetchImpl: async () => { const error = new Error('offline'); error.network = true; throw error; },
      warn: () => {},
    });

    assert.equal(release.offline, true);
    assert.equal(release.version, '3.4.5', 'the cached manifest must keep its version');
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('a cached manifest without a version still resolves for old releases', async () => {
  const { resolveRelease } = require(join(managedSrc, 'launcher.cjs'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'managed-resolve-old-'));
  const revision = 'c'.repeat(40);
  const sha = 'd'.repeat(64);
  const runtimeKey = [process.platform, process.arch, process.versions.modules].join('-');
  const runtimeRoot = join(cacheRoot, 'releases', `${sha}-${runtimeKey}`);

  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'index.js'), '// installed\n');
    await writeFile(join(runtimeRoot, '.managed-verified.json'),
      JSON.stringify({ revision, sha256: sha, size: 1, runtimeKey }));
    await writeFile(join(cacheRoot, 'last-good.json'), JSON.stringify({ revision, sha256: sha, size: 1 }));

    const release = await resolveRelease({
      url: 'http://127.0.0.1:9',
      token: 'test-token-long-enough',
      cacheRoot,
      fetchImpl: async () => { const error = new Error('offline'); error.network = true; throw error; },
      warn: () => {},
    });

    assert.equal(release.offline, true);
    assert.equal(release.version, undefined, 'an old manifest has no version and must not invent one');
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
