import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const createRequireInstance = createRequire(import.meta.url);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dash = readFileSync(path.join(ROOT, 'monitor-server', 'dashboard.cjs'), 'utf8');

test('the dashboard ships a Build tab wired to /api/builds/report', () => {
  assert.match(dash, /data-tab="build"/);
  assert.match(dash, /id="tab-build"/);
  assert.match(dash, /id="build-report"/);
  assert.match(dash, /\/api\/builds\/report\?days=30/);
  assert.match(dash, /function renderBuildTab\(report\)/);
});

test('the build box includes an ETA line with p50 and p90', () => {
  assert.match(dash, /function renderEta\(ab, jNow\)/);
  assert.match(dash, /data-eta-state=/);
  assert.match(dash, /p50–p90, n=/);
  assert.match(dash, /const estimateBuild = \$\{estimateBuild\.toString\(\)\}/);
});

test('the ETA line has labels for overdue, stalled and failed', () => {
  assert.match(dash, /lewat p90: sudah /);
  assert.match(dash, /tidak ada kemajuan /);
  assert.match(dash, /gagal setelah /);
});

test('the ETA is recomputed from the same estimator the tools use', () => {
  // The page must inline the module's estimator, not a second implementation
  // that can drift from what build_estimate answers.
  for (const name of ['MIN_SAMPLES', 'STALL_MS', 'toMs', 'numberOrNull', 'clamp0', 'minutes', 'isRevised']) {
    assert.match(dash, new RegExp(`const ${name} = \\$\\{${name}(\\.toString\\(\\))?\\}`));
  }
});

test('the inlined estimator compiles inside the page scope', () => {
  const mod = createRequireInstance('../monitor-server/build-report.cjs');
  const src = [
    `const MIN_SAMPLES = ${mod.MIN_SAMPLES};`,
    `const STALL_MS = ${mod.STALL_MS};`,
    ...['toMs', 'numberOrNull', 'clamp0', 'minutes', 'isRevised', 'estimateBuild']
      .map((name) => `const ${name} = (${mod[name].toString()});`),
  ].join('\n');
  let result;
  assert.doesNotThrow(() => {
    result = new Function(`${src}\nreturn estimateBuild({ summary: { count: 0 }, run: {}, now: 0 });`)();
  });
  assert.equal(result.state, 'no-baseline');
});
