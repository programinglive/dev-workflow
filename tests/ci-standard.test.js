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
const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

test('CI calls the shared ci-cd workflow', () => {
  assert.match(ci, /uses:\s*programinglive\/ci-cd\/\.github\/workflows\/ci-node\.yml@v1/);
});

test('CI keeps the self-hosted bw-tools runner', () => {
  assert.match(ci, /\["self-hosted","linux","bw-tools"\]/);
});

test('CI preserves the quality gates that existed before', () => {
  // The chains live in npm scripts so the caller works in any runner shell:
  // Windows runners use Windows PowerShell 5.1, where `&&` is invalid.
  assert.match(ci, /test-command:\s*npm run ci:test/);
  assert.match(ci, /lint-command:\s*npm run lint/);
  assert.match(ci, /build-command:\s*npm run ci:build/);
  assert.match(ci, /web-build-command/);
  assert.match(pkg, /"ci:test":\s*"[^"]*npm run test:security/);
  assert.match(pkg, /"ci:build":\s*"[^"]*verify:bundle/);
});
