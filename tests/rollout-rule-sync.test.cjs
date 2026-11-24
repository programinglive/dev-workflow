const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('device-entry prefers canonical DEVWF_MONITOR_URL and DEVWF_RELEASE_URL from opencode.json', () => {
  const entrySource = fs.readFileSync(path.join(__dirname, '..', 'managed', 'device-entry.cjs'), 'utf8');
  assert.match(
    entrySource,
    /DEVWF_MONITOR_URL/,
    'device-entry must enforce canonical DEVWF_MONITOR_URL from opencode.json over stale client configs',
  );
  assert.match(
    entrySource,
    /DEVWF_RELEASE_URL/,
    'device-entry must support DEVWF_RELEASE_URL configuration',
  );
});

test('workflow-guidance exports CLI-First, Mandatory Mermaid Flow, Pareto Priority, Business-Process-First / Daily Sentry Zero, and PR Reversibility rules without private host assumptions', () => {
  const guidanceSource = fs.readFileSync(path.join(__dirname, '..', 'workflow-guidance.js'), 'utf8');
  assert.match(guidanceSource, /CLI-First/);
  assert.match(guidanceSource, /Mandatory Mermaid Flow Design Gate/);
  assert.match(guidanceSource, /Pareto 80\/20 Priority-First Execution/);
  assert.match(guidanceSource, /Business-Process-First Hierarchy/);
  assert.match(guidanceSource, /Daily Sentry Zero/);
  assert.match(guidanceSource, /UI\/UX polish, cosmetics, and localization \(i18n\) ALWAYS LAST/);
  assert.match(guidanceSource, /PR\/MR Reversibility & Release-Safety Gate/);
});

test('managed rollout rule block enforces Business-Process-First, Daily Sentry Zero, and UI/UX-Last priority hierarchy', () => {
  const rolloutSource = fs.readFileSync(path.join(__dirname, '..', 'managed', 'rollout.cjs'), 'utf8');
  assert.match(rolloutSource, /Business-Process-First Hierarchy/);
  assert.match(rolloutSource, /Daily Sentry Zero/);
  assert.match(rolloutSource, /UI\/UX Polish, Cosmetics & Localization \(i18n\) ALWAYS LAST/);
});
