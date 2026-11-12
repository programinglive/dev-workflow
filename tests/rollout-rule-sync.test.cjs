/**
 * The rule sync must survive the Windows remote shell.
 *
 * TWO FAILURES MEASURED ON 8 NOVEMBER 2026
 * ----------------------------------------
 * 1. The block travelled inside `ssh "... python -c \"...\""`. The remote shell
 *    expanded the backticks, so `bw-tools` and `node managed/rollout.cjs`
 *    arrived empty: "promoted centrally to the release host on  and...".
 * 2. On Windows the multi-line script passed with `python -c "..."` is cut at
 *    the first newline by cmd.exe. It still exits 0, so the rollout printed
 *    "✅ synchronized" while `.codex/AGENTS.md` and `.gemini/GEMINI.md` kept
 *    the old text.
 *
 * The fix is structural: the script travels over stdin and the device reports
 * what it changed. These tests lock the structure in place.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rolloutPath = path.join(__dirname, '..', 'managed', 'rollout.cjs');
const source = fs.readFileSync(rolloutPath, 'utf8');

test('the remote sync sends the script over stdin, not through -c', () => {
  assert.match(source, /function syncRulesOnDevice\(/, 'the device sync must be one shared helper');
  assert.match(source, /\$\{python\} -`/, 'the remote command must end with ` -` so python reads stdin');
  assert.match(source, /\{input: `\$\{script\}\\n`\}/, 'the script must be passed as stdin input');

  // Only real code matters: the doc comment above deliberately mentions the
  // old `python -c "..."` form to explain why it was removed.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  assert.ok(
    !/python3? -c "/.test(code),
    'no remote python -c invocation may remain: cmd.exe truncates it at the first newline',
  );
});

test('the block is base64-encoded so backticks survive', () => {
  assert.match(source, /base64\.b64decode\('\$\{payload\}'\)/, 'the block must be decoded from base64 on the device');
  assert.ok(
    !/block = '''\$\{MANAGED_RULE_BLOCK\}'''/.test(source),
    'the raw block must never be interpolated into a shell command',
  );
});

test('the device verifies each write and reports what changed', () => {
  assert.match(source, /if block not in back:/, 'the device must read the file back');
  assert.match(source, /write did not stick/, 'a write that did not stick must fail loudly');
  assert.match(source, /print\("CHANGED=" \+ ","\.join\(changed\)\)/, 'changed files must be reported');
});

test('a device with no change is reported as a warning, not a success', () => {
  assert.match(source, /if \(!changed\) \{/, 'an empty change list must be handled');
  assert.match(source, /rules unchanged/, 'the warning must say nothing changed');
});

test('the rule block states the verified runner topology, not the retired claim', () => {
  // Measured 11 November 2026: the block said the MMCH Windows runner was
  // "fully decommissioned" while runner 58764237 (tag bw-server, platform
  // windows) was online and was the only runner able to execute ERP jobs.
  // Measured again 12 November 2026: the opposite error - the block still
  // demanded the MMCH runner be treated as live while GitLab returned 404 for
  // 58764237 and every ERP job already used tags: [bw-tools].
  assert.ok(
    !/fully decommissioned/.test(source),
    'the block must not use the retired wording',
  );
  assert.match(
    source,
    /CI runner topology \(verified 12 Nov 2026\)/,
    'the block must carry the verified topology with its date',
  );
  assert.match(source, /58764237/, 'the MMCH runner id must be named as removed');
  assert.match(source, /58882401/, 'the bw-tools runner id must be named');
  assert.match(source, /no Docker/, 'the Docker gap on bw-tools must be stated');
  assert.ok(
    !/still reports online/.test(source) && !/still exists and reports online/.test(source),
    'the block must not claim the MMCH runner still reports online',
  );
  assert.match(source, /deleted on 12 Nov 2026/, 'the removal must be recorded with its date');
});

test('the rule block requires registration for read-only work', () => {
  // Measured 11 November 2026: a full diagnosis ran without start_task, so the
  // monitor showed no card and the findings were untracked.
  assert.match(source, /Registration is mandatory for every task, including read-only work/);
  assert.match(source, /Focus exception/);
  assert.match(source, /MCP project lock/);
});

test('stdin is piped whenever the sync sends the script as input', () => {
  // Measured 8 November 2026: `run()` defaulted stdin to 'ignore', so the
  // script was dropped, `python -` read an empty stdin and ssh never returned.
  assert.match(
    source,
    /opts\.input == null \? \['ignore', 'pipe', 'pipe'\] : \['pipe', 'pipe', 'pipe'\]/,
    'input must switch stdin to a pipe, otherwise the script never reaches the device',
  );
});

test('remoteTargets excludes the local workstation and includes the other two fleet devices', () => {
  const rollout = require('../managed/rollout.cjs');
  assert.equal(typeof rollout.remoteTargets, 'function', 'rollout must export remoteTargets(hostname)');

  const fromMac = rollout.remoteTargets('mahatmas-MacBook-Pro.local').map((d) => d.label);
  assert.deepEqual(fromMac, ['HELLOWORLD', 'MMCH']);

  const fromHw = rollout.remoteTargets('HELLOWORLD').map((d) => d.label);
  assert.deepEqual(fromHw, ['Mac', 'MMCH']);

  const fromMmch = rollout.remoteTargets('MMCH').map((d) => d.label);
  assert.deepEqual(fromMmch, ['HELLOWORLD', 'Mac']);
});

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
    'device-entry must enforce canonical DEVWF_RELEASE_URL from opencode.json over stale client configs',
  );
});
