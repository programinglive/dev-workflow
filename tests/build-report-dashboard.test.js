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
  // The page inlines the module's estimator verbatim, so a human and an agent
  // can never be answered by two different implementations.
  assert.match(dash, /const estimateBuild = \$\{estimateBuild\.toString\(\)\};/);
});

test('a build without history still gets an honest cold-start ETA line', () => {
  // Silence would look like a broken feature; "no baseline yet" is information.
  const mod = createRequireInstance('../monitor-server/build-report.cjs');
  for (const summary of [null, undefined, { count: 0 }]) {
    const est = mod.estimateBuild({
      summary,
      run: { status: 'building', startedAt: '2026-01-01T00:00:00Z' },
      now: Date.parse('2026-01-01T00:01:00Z'),
    });
    assert.equal(est.state, 'no-baseline');
    assert.equal(est.sampleCount, 0);
  }
  assert.match(dash, /const summary = buildSummaryFor\(ab\) \|\| \{ count: 0 \};/);
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
