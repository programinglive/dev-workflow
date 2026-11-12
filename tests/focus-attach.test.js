import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncZettlyTask, assignWorkflowIdentity} from '../zettly-workflow.js';
import {syncZettlyDrawing} from '../zettly-drawing.js';

// An agent that works inside a focus must not produce orphan artifacts. The
// focus is written at creation time, not in a second call that can be forgotten.

const env = {DEVWF_ZETTLY_SYNC: '1', DEVWF_MACHINE: 'test-device'};

function workflow(focus) {
 return {
  state: {
   taskDescription: 'Attach the active focus to created artifacts',
   taskType: 'feature',
   projectDir: '/repo/workflow',
   taskStartedAt: '2026-11-12T10:00:00Z',
   currentPhase: 'coding',
   definitionOfDone: [{id: 'dod-1', text: 'Focus attached', status: 'open'}],
   plan: [{id: 'plan-1', text: 'Write the test', status: 'open'}],
   zettlyOutbox: [],
   ...(focus ? {focus} : {}),
  },
  saves: [],
  async save() { this.saves.push(structuredClone(this.state)); return {verified: true}; },
 };
}

function api() {
 const tasks = new Map();
 const calls = [];
 return {
  tasks,
  calls,
  async request(method, route, body) {
   calls.push({method, route, body});
   if (route === '/todos' && method === 'GET') return {data: [...tasks.values()]};
   if (route === '/todos' && method === 'POST') {
    const task = {...body, id: tasks.size + 1, is_completed: false};
    tasks.set(task.id, task);
    return {data: structuredClone(task)};
   }
   if (route.startsWith('/todos/')) {
    const id = Number(route.split('/').pop());
    const task = tasks.get(id);
    if (!task) throw Object.assign(new Error('Zettly HTTP 404'), {status: 404});
    if (method === 'PATCH') Object.assign(task, body);
    return {data: structuredClone(task)};
   }
   if (route.startsWith('/tags') && method === 'GET') return {tags: [], deletedTags: []};
   if (route === '/tags' && method === 'POST') return {data: {id: 1, name: body?.name ?? 'tag'}};
   if (route === '/drawings' && method === 'POST') return {data: {id: 55, title: body?.title}};
   if (route.startsWith('/drawings/') && method === 'PATCH') return {data: {id: 55, title: body?.title}};
   throw new Error('Unexpected mock route ' + method + ' ' + route);
  },
 };
}

test('a focus-bound task creates its Todo already linked to the focus', async () => {
 const state = workflow(null);
 const client = api();
 assignWorkflowIdentity(state.state, null, {});
 // assignWorkflowIdentity owns state.focus, so the focus is set the way
 // start_task sets it: after identity assignment, before the first sync.
 state.state.focus = {id: 7, title: 'Blog migration'};

 const result = await syncZettlyTask(state, {env, client});

 assert.equal(result.ok, true);
 const created = client.calls.find((call) => call.method === 'POST' && call.route === '/todos');
 assert.ok(created, 'the Todo must be created');
 assert.equal(created.body.focus_id, 7);
});

test('a task without a focus creates a Todo with no focus_id', async () => {
 const state = workflow(null);
 const client = api();
 assignWorkflowIdentity(state.state, null, {});

 await syncZettlyTask(state, {env, client});
 const created = client.calls.find((call) => call.method === 'POST' && call.route === '/todos');
 assert.ok(created);
 assert.equal(created.body.focus_id, undefined);
});

test('a focus-bound feature flow is created already linked to the focus', async () => {
 const state = workflow({id: 9, title: 'Sentry bugfix'});
 state.state.zettly = {todoId: 12};
 state.state.mermaidCode = 'flowchart TD\n A[Start] --> B[Finish]';

 const client = api();
 const result = await syncZettlyDrawing(state, {client, env});

 assert.equal(result.ok, true);
 const created = client.calls.find((call) => call.method === 'POST' && call.route === '/drawings');
 assert.ok(created, 'the drawing must be created');
 assert.equal(created.body.focus_id, 9);
});

test('a feature flow without a focus carries no focus_id', async () => {
 const state = workflow(null);
 state.state.zettly = {todoId: 12};
 state.state.mermaidCode = 'flowchart TD\n A[Start] --> B[Finish]';

 const client = api();
 await syncZettlyDrawing(state, {client, env});

 const created = client.calls.find((call) => call.method === 'POST' && call.route === '/drawings');
 assert.ok(created);
 assert.equal(created.body.focus_id, undefined);
});
