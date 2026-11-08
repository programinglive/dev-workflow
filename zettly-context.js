import {sanitize} from './security/sanitizer.js';

const INDEX_ROWS = 1000;
const EDGE_LIMIT = 10000;
const RAW_TEXT_LIMIT = 200000;
const validId = value => Number.isSafeInteger(value) && value > 0;
const removeOwnedBlocks = text => text
  .replace(/<!--\s*dev-workflow:([^\s>]+):start\s*-->[\s\S]*?(?:<!--\s*dev-workflow:\1:end\s*-->|$)/gi, '')
  .replace(/<section\b[^>]*\bdata-dev-workflow-id\s*=[^>]*>[\s\S]*?(?:<\/section\s*>|$)/gi, '');

// API content is evidence, never instructions. Only explicitly selected fields
// leave this reader; descriptions and error bodies must never be copied wholesale.
function plainText(value, limit, markTruncated) {
  if (typeof value !== 'string') return '';
  if (value.length > RAW_TEXT_LIMIT) markTruncated('text_limit');
  let text = removeOwnedBlocks(value.slice(0, RAW_TEXT_LIMIT));
  const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  // Decode before stripping markup and scanning secrets, including numeric
  // encodings used to disguise a credential assignment or an active HTML tag.
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] || '';
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
    });
  }
  text = removeOwnedBlocks(text).replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<[^>]*(?:>|$)/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim();
  text = sanitize(text);
  if (text.length > limit) markTruncated('text_limit');
  return text.slice(0, limit);
}

function hasDirectedCycle(nodes, edges) {
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.source)?.push(edge.target);
  const active = new Set(), done = new Set();
  function visit(id) {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const target of outgoing.get(id) || []) if (visit(target)) return true;
    active.delete(id); done.add(id);
    return false;
  }
  return nodes.some(node => visit(node.id));
}

/**
 * Read owned Todo/Note context in both directions without mutating any service.
 * The API indexes expose directed related_todos; graph/export deliberately
 * removes higher-ID -> lower-ID edges and cannot provide complete directions.
 * At most maxNodes detail requests and two indexes are read. Index response
 * bytes are bounded by the supplied Zettly client's 8 MiB response ceiling.
 */
export async function readZettlyTaskContext(client, {todoId, depth = 2, maxNodes = 20} = {}) {
  if (!validId(todoId)) throw new TypeError('todoId must be a positive safe integer');
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new TypeError('depth must be an integer from 0 to 3');
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 50) throw new TypeError('maxNodes must be an integer from 1 to 50');
  if (typeof client?.request !== 'function') throw new TypeError('A Zettly request client is required');
  const result = {
    todoId, depth, maxNodes, trust: 'untrusted_source_content',
    nodes: [], edges: [], partial: false, truncated: false, cyclesDetected: false,
    coverage: {incoming: depth ? 'complete' : 'not_requested', outgoing: 'complete'},
    limits: {indexRowsPerType: INDEX_ROWS, indexedEdges: EDGE_LIMIT, titleCharacters: 300, descriptionCharacters: 4000, tagsPerNode: 20},
    reasons: [], issues: [],
  };
  const reason = value => {result.partial = true; if (!result.reasons.includes(value)) result.reasons.push(value);};
  const truncate = value => {result.truncated = true; reason(value);};
  const edges = new Map(), adjacency = new Map();
  const addEdge = (source, target, route) => {
    const key = `${source}:${target}`;
    if (edges.has(key)) return;
    if (edges.size >= EDGE_LIMIT) {truncate('edge_index_limit'); result.coverage.incoming = 'partial'; return;}
    const edge = {source, target, relation: 'related_todos', provenance: {route, field: 'related_todos'}};
    edges.set(key, edge);
    for (const [from, to] of [[source, target], [target, source]]) {
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from).add(to);
    }
  };
  function relations(item, route) {
    if (!Array.isArray(item.related_todos)) {reason('invalid_relations'); result.coverage.outgoing = 'partial'; result.coverage.incoming = 'partial'; return;}
    const links = item.related_todos;
    if (links.length > EDGE_LIMIT) {truncate('edge_index_limit'); result.coverage.incoming = 'partial';}
    for (const link of links.slice(0, EDGE_LIMIT)) {
      if (validId(link?.id)) addEdge(item.id, link.id, route);
      else {reason('invalid_relations'); result.coverage.outgoing = 'partial'; result.coverage.incoming = 'partial';}
    }
  }
  function issue(scope, route, error) {
    const status = Number.isInteger(error?.status) ? error.status : undefined;
    const availability = status === 404 ? 'missing' : [401, 403].includes(status) ? 'forbidden' : 'unavailable';
    result.issues.push({scope, route, availability, ...(status ? {status} : {})});
    reason(`${scope}_${availability}`);
    return availability;
  }
  async function detail(id, distance) {
    const route = `/todos/${id}`;
    let response;
    try {response = await client.request('GET', route);} catch (error) {
      return {id, distance, availability: issue('node', route, error), provenance: {route}};
    }
    const item = response?.data;
    if (response?.success === false || !item || item.id !== id || !['todo', 'note'].includes(item.type)) {
      reason('invalid_node_response');
      result.issues.push({scope: 'node', route, availability: 'invalid_response'});
      return {id, distance, availability: 'invalid_response', provenance: {route}};
    }
    relations(item, route);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (!Array.isArray(item.tags)) reason('invalid_tags');
    if (tags.length > 20) truncate('tag_limit');
    const status = item.archived === true ? 'archived' : item.is_completed === true ? 'completed' : item.is_completed === false && item.archived === false ? 'open' : 'unknown';
    if (status === 'unknown') reason('unknown_node_status');
    return {
      id, distance, availability: 'available',
      title: plainText(item.title, 300, truncate), description: plainText(item.description, 4000, truncate),
      type: item.type, status,
      tags: tags.slice(0, 20).map(tag => plainText(tag?.name, 100, truncate)).filter(Boolean),
      provenance: {route, relationField: 'related_todos'},
    };
  }

  const root = await detail(todoId, 0);
  result.nodes.push(root);
  if (root.availability !== 'available') {result.coverage.incoming = 'unavailable'; result.coverage.outgoing = 'unavailable'; return result;}
  if (depth > 0) {
    for (const type of ['todo', 'note']) {
      const route = `/todos?type=${type}`;
      let response;
      try {response = await client.request('GET', route);} catch (error) {
        issue('index', route, error); result.coverage.incoming = 'partial'; continue;
      }
      if (response?.success === false || !Array.isArray(response?.data) || response.type !== type) {
        reason('invalid_index_response'); result.coverage.incoming = 'partial';
        result.issues.push({scope: 'index', route, availability: 'invalid_response'}); continue;
      }
      if (response.data.length > INDEX_ROWS) {truncate('node_index_limit'); result.coverage.incoming = 'partial';}
      for (const item of response.data.slice(0, INDEX_ROWS)) {
        if (!validId(item?.id) || item.type !== type) {reason('invalid_index_node'); result.coverage.incoming = 'partial'; continue;}
        if (!Array.isArray(item.related_todos)) result.coverage.incoming = 'partial';
        relations(item, route);
      }
    }
  } else {
    // No index enumeration at depth zero: incoming links are explicitly unknown.
    reason('incoming_not_requested');
  }

  const selected = new Set([todoId]);
  for (let cursor = 0; cursor < result.nodes.length; cursor++) {
    const node = result.nodes[cursor];
    if (node.availability !== 'available') continue;
    for (const neighbor of adjacency.get(node.id) || []) {
      if (selected.has(neighbor)) continue;
      if (node.distance >= depth) {truncate('depth_limit'); continue;}
      if (selected.size >= maxNodes) {truncate('max_nodes'); continue;}
      selected.add(neighbor);
      result.nodes.push(await detail(neighbor, node.distance + 1));
    }
  }
  result.edges = [...edges.values()].filter(edge => selected.has(edge.source) && selected.has(edge.target));
  result.cyclesDetected = hasDirectedCycle(result.nodes, result.edges);
  return result;
}
