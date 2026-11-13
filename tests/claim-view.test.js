/**
 * Task claim visibility.
 *
 * Measured 8 November 2026: an agent starting work had no way to see which
 * tasks other AI sessions already hold. `start_task` refused only after the
 * agent had already chosen a task, and the refusal named a single PID without
 * saying which project, agent, or task that process was working on.
 *
 * This module answers the question before the choice is made: which tasks are
 * claimed right now, by whom, and since when.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {describeClaims, summarizeClaim, CLAIM_STALE_MS} from '../claim-view.js';

const NOW = Date.parse('2026-11-08T10:00:00Z');
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();

function claim(overrides = {}) {
  return {
    machine: 'HELLOWORLD',
    projectName: 'clinic',
    task: 'Merge concurrent treatments',
    agent: 'opencode',
    sessionKey: 'ses_abc123',
    phase: 'coding',
    updatedAt: minutesAgo(3),
    ownerPid: 4242,
    ...overrides,
  };
}

test('a fresh claim from another session is reported', () => {
  const result = summarizeClaim({ claim: claim(), now: NOW, ownSessionKey: 'ses_self' });
  assert.equal(result.claimed, true);
  assert.equal(result.reason, 'held');
});

test('a claim owned by this session is not reported', () => {
  const result = summarizeClaim({ claim: claim({sessionKey: 'ses_self'}), now: NOW, ownSessionKey: 'ses_self' });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'own');
});

test('a stale claim is not reported', () => {
  const result = summarizeClaim({ claim: claim({updatedAt: minutesAgo(45)}), now: NOW, ownSessionKey: 'ses_self' });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'stale');
});

test('claim staleness boundary is exclusive at the limit', () => {
  const atLimit = summarizeClaim({
    claim: claim({updatedAt: new Date(NOW - CLAIM_STALE_MS).toISOString()}),
    now: NOW,
    ownSessionKey: 'ses_self',
  });
  assert.equal(atLimit.claimed, true, 'exactly at the limit is still fresh');

  const past = summarizeClaim({
    claim: claim({updatedAt: new Date(NOW - CLAIM_STALE_MS - 1).toISOString()}),
    now: NOW,
    ownSessionKey: 'ses_self',
  });
  assert.equal(past.claimed, false);
});

test('an idle claim is not a claim', () => {
  const result = summarizeClaim({ claim: claim({phase: 'idle'}), now: NOW, ownSessionKey: 'ses_self' });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'idle');
});

test('describeClaims renders a readable list with project, agent and age', () => {
  const lines = describeClaims({
    now: NOW,
    ownSessionKey: 'ses_self',
    claims: [
      claim(),
      claim({projectName: 'portal-beautyworld', task: 'Migration', agent: 'codex', sessionKey: 'ses_xyz', updatedAt: minutesAgo(12)}),
      claim({sessionKey: 'ses_self'}),
      claim({projectName: 'stale', updatedAt: minutesAgo(90)}),
    ],
  });

  assert.equal(lines.length, 2, 'own and stale claims are excluded');
  assert.match(lines[0], /clinic/);
  assert.match(lines[0], /opencode/);
  assert.match(lines[0], /3m/);
  assert.match(lines[1], /portal-beautyworld/);
  assert.match(lines[1], /codex/);
});

test('describeClaims returns an empty list when nothing is claimed', () => {
  assert.deepEqual(describeClaims({now: NOW, ownSessionKey: 'ses_self', claims: []}), []);
});
