/**
 * The repository must use the shared CI standard, not a hand-written pipeline.
 *
 * Measured 7 November 2026: every project had its own workflow, and the live
 * monitor was deployed by hand because no pipeline existed for it. This test
 * keeps this repository on the shared workflow and keeps the quality gates that
 * already existed.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('CI calls the shared ci-cd workflow', () => {
  assert.match(ci, /uses:\s*programinglive\/ci-cd\/\.github\/workflows\/ci-node\.yml@v1/);
});

test('CI keeps the self-hosted MMCH runner', () => {
  assert.match(ci, /\["self-hosted","windows","mmch"\]/);
});

test('CI preserves the quality gates that existed before', () => {
  assert.match(ci, /npm run test:security/);
  assert.match(ci, /npm run lint/);
  assert.match(ci, /verify-bundle/);
  assert.match(ci, /web-build-command/);
});
