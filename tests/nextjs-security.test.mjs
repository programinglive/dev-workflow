import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guard the Next.js security baseline of the Developer Portal (`web/`).
 *
 * GHSA-pc58-hwjq-p385 / CVE-2026-119348 (published 2026-11-03):
 *   affected  next >= 16.0.0, <= 16.4.4   (and <= 15.5.28)
 *   patched   next 16.4.5                 (and 15.5.29)
 *
 * Self-hosted App Router route handlers that forward a fetched upstream
 * response unchanged can desynchronize responses between clients behind an
 * HTTP/1.1 reverse proxy that allows pipelined response queueing.
 *
 * The lockfile is the source of truth: it is committed, and `npm ci` installs
 * exactly it. Asserting on the lockfile means a stale local `node_modules`
 * cannot hide a vulnerable resolution, and a future lockfile regression fails
 * CI instead of silently shipping.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = JSON.parse(readFileSync(path.join(repoRoot, 'web', 'package-lock.json'), 'utf8'));
const entry = lockfile.packages?.['node_modules/next'];

test('web/package-lock.json pins a resolvable next package', () => {
  assert.ok(entry, 'node_modules/next must be present in web/package-lock.json');
  assert.match(entry.version, /^\d+\.\d+\.\d+/, 'next version must be an exact release');
});

test('resolved Next.js is outside the GHSA-pc58-hwjq-p385 affected range', () => {
  const [major, minor, patch] = entry.version.split('.').map(Number);
  const inVulnerable16 = major === 16 && (minor < 4 || (minor === 4 && patch <= 4));
  const inVulnerable15 = major === 15 && (minor < 5 || (minor === 5 && patch <= 28));
  const inVulnerable14 = major === 14;
  assert.ok(
    !inVulnerable16 && !inVulnerable15 && !inVulnerable14,
    `next@${entry.version} is affected by GHSA-pc58-hwjq-p385 (patched in 16.4.5 / 15.5.29); ` +
      'bump web/package.json and the lockfile to a patched release',
  );
});

test('the declared range cannot resolve below the patched release', () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'web', 'package.json'), 'utf8'));
  const range = String(manifest.dependencies?.next || '');
  assert.ok(range, 'web/package.json must declare next');
  const minimum = range.replace(/^[^\d]*/, '').split('.').map(Number);
  assert.ok(minimum.length >= 2 && Number.isFinite(minimum[0]), `cannot parse next range: ${range}`);
  // The floor of the range must be at least the patched 16.4.5 line.
  const [maj, min, pat] = minimum;
  const floorIsPatched = maj > 16 || (maj === 16 && (min > 4 || (min === 4 && pat >= 5)));
  assert.ok(
    floorIsPatched,
    `next range "${range}" allows a version affected by GHSA-pc58-hwjq-p385; raise the floor to >= 16.4.5`,
  );
});
