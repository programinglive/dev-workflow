import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTaskId,
  normalizePositiveInt,
  createTaskIdentity,
  extractTaskIdentity,
} from '../contracts/task-identity.js';

test('isValidTaskId validates canonical identifiers', () => {
  assert.equal(isValidTaskId('task-12345'), true);
  assert.equal(isValidTaskId('workflow-abcdef0123456789'), true);
  assert.equal(isValidTaskId('uuid-v4-standard-format'), true);
  assert.equal(isValidTaskId(''), false);
  assert.equal(isValidTaskId('a'), false); // too short
  assert.equal(isValidTaskId('   '), false);
  assert.equal(isValidTaskId(null), false);
  assert.equal(isValidTaskId(123), false);
});

test('normalizePositiveInt normalizes IDs safely', () => {
  assert.equal(normalizePositiveInt(42), 42);
  assert.equal(normalizePositiveInt('42'), 42);
  assert.equal(normalizePositiveInt(0), null);
  assert.equal(normalizePositiveInt(-5), null);
  assert.equal(normalizePositiveInt('abc'), null);
  assert.equal(normalizePositiveInt(null), null);
  assert.equal(normalizePositiveInt(undefined), null);
});

test('createTaskIdentity builds immutable mapping with digest', () => {
  const identity = createTaskIdentity({
    taskId: 'canonical-task-001',
    zettlyTodoId: 634,
    focusId: 67,
    drawingId: 108,
    executionId: 'exec-99',
    gitBranch: 'feat/test',
    repo: 'D:/code/my-repo',
  });

  assert.equal(identity.taskId, 'canonical-task-001');
  assert.equal(identity.zettly.todoId, 634);
  assert.equal(identity.zettly.focusId, 67);
  assert.equal(identity.zettly.drawingId, 108);
  assert.equal(identity.execution.executionId, 'exec-99');
  assert.equal(identity.git.branch, 'feat/test');
  assert.equal(identity.git.repo, 'D:/code/my-repo');

  // Verify immutability
  assert.throws(() => { identity.taskId = 'hacked'; });
  assert.throws(() => { identity.zettly.todoId = 999; });

  // Digest is deterministic
  const digest1 = identity.digest();
  assert.equal(typeof digest1, 'string');
  assert.equal(digest1.length, 64);
  assert.equal(digest1, identity.digest());

  // toZettlyMeta
  const meta = identity.toZettlyMeta();
  assert.deepEqual(meta, {
    workflowTaskId: 'canonical-task-001',
    zettlyTodoId: 634,
    executionId: 'exec-99',
  });
});

test('extractTaskIdentity extracts normalized identity from legacy WorkflowState', () => {
  const mockState = {
    workflowTaskId: 'legacy-task-xyz',
    projectDir: 'D:/code/zettly',
    lastPushBranch: 'main',
    sessionId: 'session-123',
    focus: { id: 70, title: 'Approval Void' },
    zettly: {
      todoId: 500,
      externalLinks: {
        drawing: { id: 25 },
      },
    },
  };

  const identity = extractTaskIdentity(mockState);
  assert.equal(identity.taskId, 'legacy-task-xyz');
  assert.equal(identity.zettly.todoId, 500);
  assert.equal(identity.zettly.focusId, 70);
  assert.equal(identity.zettly.drawingId, 25);
  assert.equal(identity.git.repo, 'D:/code/zettly');
  assert.equal(identity.git.branch, 'main');
});
