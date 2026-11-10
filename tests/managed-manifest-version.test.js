/**
 * The managed release manifest must carry a version.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the wire protocol was {revision, sha256, size}. Answering "which
 * dev-workflow version is this device running?" required SSH-ing to the device
 * and reading package.json inside the release directory. On a three-device fleet
 * that is not an answer, it is a chore.
 *
 * The blocker was not the manifest file: protocol.cjs rebuilt the object from
 * three fields, so anything else was silently dropped before it ever reached a
 * client. These tests pin the version all the way through the two places that
 * transform the manifest.
 *
 * Run: node --test tests/managed-manifest-version.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const managedSrc = process.env.MANAGED_SRC || join(process.cwd(), 'managed');
const { validateManifest } = require(join(managedSrc, 'protocol.cjs'));

const REVISION = 'a'.repeat(40);
const SHA = 'b'.repeat(64);

function manifest(extra = {}) {
  return { revision: REVISION, sha256: SHA, size: 1024, ...extra };
}

test('a manifest without a version is still valid, for backward compatibility', () => {
  const result = validateManifest(manifest());
  assert.equal(result.revision, REVISION);
  assert.equal(result.sha256, SHA);
  assert.equal(result.size, 1024);
  assert.equal(result.version, undefined, 'an absent version must stay absent, not become a placeholder');
});

test('a manifest with a semver version keeps it', () => {
  const result = validateManifest(manifest({ version: '1.28.0' }));
  assert.equal(result.version, '1.28.0');
});

test('a prerelease and build-metadata version is accepted', () => {
  for (const version of ['2.0.0-rc.1', '1.28.0+build.5', '0.0.1']) {
    assert.equal(validateManifest(manifest({ version })).version, version);
  }
});

test('a malformed version is rejected rather than passed through', () => {
  for (const version of ['', ' ', 'v1.28.0', 'one.two.three', '1.28', '1.28.0.4', '1.28.0 <script>']) {
    assert.throws(
      () => validateManifest(manifest({ version })),
      /Invalid managed release manifest/,
      `version ${JSON.stringify(version)} should be rejected`
    );
  }
});

test('a non-string version is rejected', () => {
  for (const version of [128, null, {}, [], true]) {
    assert.throws(() => validateManifest(manifest({ version })), /Invalid managed release manifest/);
  }
});

test('the version survives the round trip a client performs', () => {
  const served = validateManifest(manifest({ version: '1.28.0' }));
  // The client parses what the server sent and validates it again.
  const received = validateManifest(JSON.parse(JSON.stringify(served)));
  assert.equal(received.version, '1.28.0');
  assert.equal(received.revision, REVISION);
});

test('revision, sha256 and size checks still reject bad input', () => {
  assert.throws(() => validateManifest({ ...manifest(), revision: 'short' }), /Invalid/);
  assert.throws(() => validateManifest({ ...manifest(), sha256: 'nope' }), /Invalid/);
  assert.throws(() => validateManifest({ ...manifest(), size: 0 }), /Invalid/);
  assert.throws(() => validateManifest({ ...manifest(), size: 65 * 1024 * 1024 }), /Invalid/);
  assert.throws(() => validateManifest(null), /Invalid/);
});

test('the release server forwards the version it reads from current.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-version-'));
  const token = 'test-token-long-enough';
  const { createReleaseServer } = require(join(managedSrc, 'release-server.cjs'));

  try {
    await writeFile(join(root, 'current.json'), JSON.stringify(manifest({ version: '9.9.9' })) + '\n');

    const server = createReleaseServer({ root, token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/v1/current`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.version, '9.9.9', 'the version must not be dropped by the server');
    assert.equal(body.revision, REVISION);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the release server refuses a manifest whose version is malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-badversion-'));
  const token = 'test-token-long-enough';
  const { createReleaseServer } = require(join(managedSrc, 'release-server.cjs'));

  try {
    await writeFile(join(root, 'current.json'), JSON.stringify(manifest({ version: 'not-semver' })) + '\n');

    const server = createReleaseServer({ root, token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/v1/current`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 503, 'a bad manifest must be refused, not served');

    await new Promise((resolve) => server.close(resolve));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
