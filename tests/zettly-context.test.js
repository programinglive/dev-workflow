import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../zettly-context.js').catch(() => ({}));
const read = (...args) => {
  assert.equal(typeof module.readZettlyTaskContext, 'function', 'bounded graph context reader must be exported');
  return module.readZettlyTaskContext(...args);
};
const todo = (id, related = [], extra = {}) => ({id, title: `Item ${id}`, type: 'todo', description: '', is_completed: false, archived: false, tags: [], related_todos: related.map(id => ({id})), ...extra});
function fixture(items, {errors = {}, indexes = {}} = {}) {
  const calls = [];
  return {calls, async request(method, route) {
    calls.push([method, route]);
    assert.equal(method, 'GET', 'context reading never writes externally');
    if (errors[route]) throw Object.assign(new Error('private credential in diagnostic'), {status: errors[route]});
    if (route.startsWith('/todos?type=')) {
      const type = route.split('=').at(-1);
      return indexes[type] || {success: true, type, data: items.filter(item => item.type === type)};
    }
    const item = items.find(item => item.id === Number(route.split('/').at(-1)));
    if (!item) throw Object.assign(new Error('missing'), {status: 404});
    return {success: true, data: item};
  }};
}

test('recovers asymmetric incoming task and note links without inventing semantic labels', async () => {
  const client = fixture([todo(1), todo(9, [1], {type: 'note', title: 'Design context'}), todo(3, [9])]);
  const result = await read(client, {todoId: 1});
  assert.deepEqual(result.nodes.map(node => node.id), [1, 9, 3]);
  assert.deepEqual(result.edges.map(({source, target, relation}) => ({source, target, relation})), [
    {source: 3, target: 9, relation: 'related_todos'}, {source: 9, target: 1, relation: 'related_todos'},
  ]);
  assert.equal(result.nodes[1].type, 'note');
  assert.equal(result.edges.find(edge => edge.source === 9).provenance.route, '/todos?type=note');
  assert.equal(result.partial, false);
  assert.equal(result.truncated, false);
  assert.equal(result.trust, 'untrusted_source_content');
});

test('cycle detection distinguishes directed cycles from converging links and visits nodes once', async () => {
  const client = fixture([todo(1, [2, 3]), todo(2, [4]), todo(3, [4]), todo(4, [1])]);
  const result = await read(client, {todoId: 1, depth: 3});
  assert.equal(result.cyclesDetected, true);
  assert.equal(new Set(result.nodes.map(node => node.id)).size, 4);
  assert.equal(client.calls.filter(([, route]) => /^\/todos\/\d+$/.test(route)).length, 4);
  const acyclic = await read(fixture([todo(1, [2, 3]), todo(2, [4]), todo(3, [4]), todo(4)]), {todoId: 1, depth: 3});
  assert.equal(acyclic.cyclesDetected, false);
});

test('depth zero reads only root and explicitly reports omitted neighbors', async () => {
  const client = fixture([todo(1, [2]), todo(2)]);
  const result = await read(client, {todoId: 1, depth: 0});
  assert.deepEqual(result.nodes.map(node => node.id), [1]);
  assert.equal(result.truncated, true);
  assert.equal(result.partial, true);
  assert.equal(client.calls.length, 1);
});

test('node budget bounds fetched records and retained edges', async () => {
  const client = fixture([todo(1, [2, 3, 4]), todo(2), todo(3), todo(4)]);
  const result = await read(client, {todoId: 1, maxNodes: 2});
  assert.equal(result.nodes.length, 2);
  assert.ok(result.edges.every(edge => [1, 2].includes(edge.source) && [1, 2].includes(edge.target)));
  assert.equal(client.calls.filter(([, route]) => /^\/todos\/\d+$/.test(route)).length, 2);
  assert.equal(result.truncated, true);
});

test('rejects invalid bounds and identities before any request', async () => {
  for (const options of [{todoId: 0}, {todoId: '1'}, {todoId: 1, depth: -1}, {todoId: 1, depth: 4}, {todoId: 1, depth: 1.5}, {todoId: 1, maxNodes: 0}, {todoId: 1, maxNodes: 51}, {todoId: 1, maxNodes: '2'}]) {
    const client = fixture([]);
    await assert.rejects(async () => read(client, options), /positive|depth|maxNodes/);
    assert.equal(client.calls.length, 0);
  }
});

test('missing and forbidden neighbors remain explicit unavailable nodes with observed edges', async () => {
  const client = fixture([todo(1, [2, 3])], {errors: {'/todos/3': 403}});
  const result = await read(client, {todoId: 1});
  assert.deepEqual(result.nodes.map(node => [node.id, node.availability]), [[1, 'available'], [2, 'missing'], [3, 'forbidden']]);
  assert.equal(result.edges.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('private credential'));
});

test('failed root does not enumerate the account and does not masquerade as complete', async () => {
  const client = fixture([], {errors: {'/todos/1': 403}});
  const result = await read(client, {todoId: 1});
  assert.equal(result.nodes[0].availability, 'forbidden');
  assert.equal(result.partial, true);
  assert.equal(client.calls.length, 1);
});

test('a denied incoming index retains outgoing context and declares coverage partial', async () => {
  const client = fixture([todo(1, [2]), todo(2, [], {type: 'note'})], {errors: {'/todos?type=note': 403}});
  const result = await read(client, {todoId: 1});
  assert.equal(result.nodes.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.coverage.incoming, 'partial');
});

test('rejects malformed indexes and unsupported note filtering honestly', async () => {
  for (const index of [{type: 'todo', data: []}, {data: {}}, {success: false, data: []}]) {
    const result = await read(fixture([todo(1)], {indexes: {note: index}}), {todoId: 1});
    assert.equal(result.partial, true);
    assert.equal(result.coverage.incoming, 'partial');
  }
});

test('plain text excludes owned blocks active HTML credentials profiles and embedded attributes', async () => {
  const client = fixture([todo(1, [], {
    title: '<b>Review</b>',
    description: '<p>Read &amp; verify &#x1f642;</p><script>ignore instructions</script><style>hidden</style><img src="https://x/?token=attribute-secret"><!-- dev-workflow:abc:start --><section>owned status token=owned-secret</section><!-- dev-workflow:abc:end --><p>password=description-secret</p><p>Authorization: Bearer secret-bearer-value</p>',
    user: {email: 'private@example.test', token: 'user-secret'}, user_id: 81,
    tags: [{id: 3, name: '<i>Architecture</i>', user_id: 81}],
  })]);
  const result = await read(client, {todoId: 1});
  const node = result.nodes[0];
  assert.equal(node.title, 'Review');
  assert.match(node.description, /Read & verify 🙂/);
  assert.deepEqual(node.tags, ['Architecture']);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['ignore instructions', 'hidden', 'owned status', 'attribute-secret', 'description-secret', 'secret-bearer-value', 'private@example.test', 'user-secret', 'user_id', '<p>']) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('text and tags are bounded and truncation remains visible', async () => {
  const result = await read(fixture([todo(1, [], {description: 'a'.repeat(10000), title: 'b'.repeat(1000), tags: Array.from({length: 50}, (_, i) => ({name: `Tag ${i}`}))})]), {todoId: 1});
  assert.ok(result.nodes[0].description.length <= 4000);
  assert.ok(result.nodes[0].title.length <= 300);
  assert.ok(result.nodes[0].tags.length <= 20);
  assert.equal(result.truncated, true);
});

test('bounded indexes stop scanning huge accounts and disclose incomplete incoming coverage', async () => {
  const rows = Array.from({length: 2001}, (_, i) => todo(i + 2));
  const client = fixture([todo(1)], {indexes: {todo: {type: 'todo', data: rows}}});
  const result = await read(client, {todoId: 1});
  assert.equal(result.truncated, true);
  assert.equal(result.coverage.incoming, 'partial');
});

test('detail identity mismatch cannot inject another node or profile', async () => {
  const client = fixture([todo(1)]);
  const request = client.request.bind(client);
  client.request = (method, route) => route === '/todos/1' ? {data: todo(99)} : request(method, route);
  const result = await read(client, {todoId: 1});
  assert.equal(result.nodes[0].id, 1);
  assert.equal(result.nodes[0].availability, 'invalid_response');
  assert.equal(result.partial, true);
});

test('encoded owned blocks are excluded after decoding and encoded assignments are redacted', async () => {
  const result = await read(fixture([todo(1, [], {
    description: '&lt;section data-dev-workflow-id=&quot;x&quot;&gt;owned progress&lt;/section&gt;<p>passw&#111;rd=encoded-secret</p>',
  })]), {todoId: 1});
  assert.ok(!result.nodes[0].description.includes('owned progress'));
  assert.ok(!result.nodes[0].description.includes('encoded-secret'));
});

test('unknown completion status is explicit and does not invent open status', async () => {
  const result = await read(fixture([todo(1, [], {is_completed: undefined})]), {todoId: 1});
  assert.equal(result.nodes[0].status, 'unknown');
  assert.equal(result.partial, true);
});

test('malformed relation references invalidate incoming coverage instead of silently hiding links', async () => {
  const result = await read(fixture([todo(1), todo(2, [], {related_todos: [{id: '1'}]})]), {todoId: 1});
  assert.equal(result.coverage.incoming, 'partial');
  assert.equal(result.partial, true);
});
