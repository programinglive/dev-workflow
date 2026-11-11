import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getToolList } from '../tools/definitions.js';
import { handleRefineWithAi } from '../tools/handler-modules/refine-with-ai.js';

function fixture() {
  const state = {
    currentPhase: 'coding', workflowTaskId: 'task-1', taskDescription: 'Fix checkout',
    plan: [{ id: 'plan-1', text: 'Reproduce checkout failure', status: 'done' }],
    definitionOfDone: [{ id: 'dod-1', text: 'Checkout regression passes', status: 'done', evidence: 'node --test checkout', revision: 0 }],
    dodRevision: 0, zettly: { todoId: 541 },
  };
  return { state, saved: 0, async save() { this.saved++; return { verified: true }; } };
}

const revised = {
  taskId: 'task-1',
  newContext: 'The failure occurs only when the existing coupon is expired.',
  description: 'Fix checkout rejection for expired coupons while preserving prior checkout behavior.',
  plan: ['Reproduce checkout failure', 'Add expired coupon regression', 'Implement and verify checkout fix'],
  definitionOfDone: ['Checkout regression passes', 'Expired coupon regression passes'],
};

test('catalog puts refine_with_ai immediately after start_task', () => {
  const names = getToolList().map(tool => tool.name);
  assert.equal(names[names.indexOf('start_task') + 1], 'refine_with_ai');
});

test('refinement updates the same task, keeps prior context and verified evidence', async () => {
  const workflow = fixture();
  const response = await handleRefineWithAi(revised, workflow);
  assert.equal(response.isError, undefined);
  assert.equal(workflow.state.workflowTaskId, 'task-1');
  assert.equal(workflow.state.zettly.todoId, 541);
  assert.equal(workflow.state.definitionOfDone[0].evidence, 'node --test checkout');
  assert.equal(workflow.state.definitionOfDone[1].status, 'open');
  assert.equal(workflow.state.plan[0].status, 'done');
  assert.match(workflow.state.refinement.context, /expired/);
  assert.match(workflow.state.refinement.previousDescription, /Fix checkout/);
  assert.equal(workflow.saved, 1);
});

test('second refinement retains earlier context and does not duplicate the canonical task', async () => {
  const workflow = fixture();
  await handleRefineWithAi(revised, workflow);
  await handleRefineWithAi({ ...revised, newContext: 'The fix must cover guest checkout too.' }, workflow);
  assert.match(workflow.state.refinement.context, /expired/);
  assert.match(workflow.state.refinement.context, /guest checkout/);
  assert.equal(workflow.state.refinement.revision, 2);
  assert.equal(workflow.state.workflowTaskId, 'task-1');
});

test('retrying an identical refinement does not append duplicate context', async () => {
  const workflow = fixture();
  await handleRefineWithAi(revised, workflow);
  await handleRefineWithAi(revised, workflow);
  assert.equal(workflow.state.refinement.revision, 1);
  assert.equal(workflow.state.refinement.context.split('expired').length - 1, 1);
  assert.equal(workflow.saved, 1);
});

test('wrong task identity and incomplete reconstruction do not mutate state', async () => {
  const workflow = fixture();
  const before = structuredClone(workflow.state);
  assert.equal((await handleRefineWithAi({ ...revised, taskId: 'another-task' }, workflow)).isError, true);
  assert.equal((await handleRefineWithAi({ ...revised, plan: [] }, workflow)).isError, true);
  assert.deepEqual(workflow.state, before);
  assert.equal(workflow.saved, 0);
});

test('refinement rejects removing proven evidence', async () => {
  const workflow = fixture();
  const before = structuredClone(workflow.state);
  const response = await handleRefineWithAi({ ...revised, definitionOfDone: ['Expired coupon regression passes'] }, workflow);
  assert.equal(response.isError, true);
  assert.deepEqual(workflow.state, before);
});

test('refinement rejects an inactive task', async () => {
  const workflow = fixture();
  workflow.state.currentPhase = 'idle';
  assert.equal((await handleRefineWithAi(revised, workflow)).isError, true);
  assert.equal(workflow.saved, 0);
});

test('failed save restores the prior task state', async () => {
  const workflow = fixture();
  const before = structuredClone(workflow.state);
  workflow.save = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(() => handleRefineWithAi(revised, workflow), /storage unavailable/);
  assert.deepEqual(workflow.state, before);
});

test('bugfix refinement requires a concrete investigation brief', async () => {
  const workflow = fixture();
  workflow.state.taskType = 'bugfix';
  const before = structuredClone(workflow.state);
  const response = await handleRefineWithAi(revised, workflow);
  assert.equal(response.isError, true);
  assert.deepEqual(workflow.state, before);
});

test('bugfix refinement saves reproduction, expected and observed behavior, evidence, and constraints', async () => {
  const workflow = fixture();
  workflow.state.taskType = 'bugfix';
  const bugContext = {
    symptom: 'Checkout rejects an expired coupon without identifying the coupon.',
    reproduction: ['Create an expired coupon', 'Apply it in guest checkout'],
    observed: 'Checkout returns a generic error.',
    expected: 'Checkout identifies the expired coupon and keeps the cart.',
    evidence: 'Checkout trace 2026-11-11 and failing regression test.',
    constraints: 'Preserve valid coupon behavior and cart state.',
  };
  const response = await handleRefineWithAi({ ...revised, bugContext }, workflow);
  assert.equal(response.isError, undefined);
  assert.deepEqual(workflow.state.refinement.bugContext, bugContext);
  assert.match(response.content[0].text, /guest checkout/);
  assert.match(response.content[0].text, /failing regression test/);
});

test('every revision is kept in history, not only the last one', async () => {
  const workflow = fixture();
  await handleRefineWithAi(revised, workflow);
  await handleRefineWithAi({ ...revised, newContext: 'The fix must cover guest checkout too.' }, workflow);

  const history = workflow.state.refinement.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].revision, 1);
  assert.equal(history[1].revision, 2);
  assert.match(history[0].newContext, /expired/);
  assert.match(history[1].newContext, /guest checkout/);
  assert.ok(history[0].at, 'each revision records when it happened');
  assert.equal(history[1].plan.length, revised.plan.length);
});

test('history is capped so a long session cannot grow the state without bound', async () => {
  const workflow = fixture();
  for (let i = 0; i < 12; i += 1) {
    await handleRefineWithAi({ ...revised, newContext: `Revision context number ${i} for the checkout fix.` }, workflow);
  }

  const history = workflow.state.refinement.history;
  assert.equal(history.length, 10);
  assert.equal(history[history.length - 1].revision, 12);
  assert.equal(history[0].revision, 3);
});
