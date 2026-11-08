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
