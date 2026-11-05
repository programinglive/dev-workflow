'use strict';

// Self-contained so the dashboard can reuse the exact validator in the browser.
function normalizeTaskMetadata(input) {
  const value = input && typeof input === 'object' ? input : {};
  const text = (v, limit) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
  const safeUrl = v => {
    if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v)) return '';
    try {
      const url = new URL(v);
      // Queries/fragments can contain auth material; resource links need neither.
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
      return url.href;
    } catch { return ''; }
  };
  const record = (v, systems, relation) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !systems.includes(v.system)) return null;
    const result = { system: v.system, id: text(v.id, 200), url: safeUrl(v.url), label: text(v.label, 200) };
    if (relation) result.relation = text(v.relation, 80);
    return result;
  };
  const origin = record(value.taskOrigin, ['zettly', 'factory', 'sentry', 'manual', 'unknown'], false) || {};
  const relations = [];
  const seen = new Set();
  if (Array.isArray(value.taskRelations)) {
    for (const item of value.taskRelations.slice(0, 120)) {
      const normalized = record(item, ['zettly', 'zettly_draw', 'factory', 'sentry'], true);
      if (!normalized || !normalized.id) continue;
      const key = normalized.system + ':' + normalized.id + ':' + normalized.relation;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push(normalized);
      if (relations.length === 64) break;
    }
  }
  return { workflowTaskId: text(value.workflowTaskId, 200), taskOrigin: origin, taskRelations: relations };
}

function renderTaskMetadata(session) {
  const normalized = normalizeTaskMetadata({
    workflowTaskId: session.workflow_task_id,
    taskOrigin: session.task_origin_json,
    taskRelations: session.task_relations_json,
  });
  const escape = v => String(v || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const names = { zettly: 'Zettly', zettly_draw: 'Zettly Draw', factory: 'Factory', sentry: 'Sentry', manual: 'Manual', unknown: 'Unknown' };
  const item = (record, relation) => {
    const prefix = names[record.system];
    const label = record.label || '';
    const shortId = record.id ? (record.system === 'factory' ? record.id.slice(0, 8) : record.id) : '';
    const named = label.startsWith(prefix + ' ') ? label : record.system === 'zettly_draw' && label.startsWith('Draw #') ? 'Zettly ' + label : prefix + (label ? (['factory', 'sentry'].includes(record.system) ? ' ' : ' · ') + label : '');
    const main = shortId && !named.includes(shortId) ? named + ' #' + shortId : named;
    const relationNames = { tracks: 'Todo', executes: 'eksekusi', visual_plan: 'rencana visual', source_issue: 'isu sumber', focus: 'fokus' };
    const text = main + (relation && relationNames[record.relation] ? ' · ' + relationNames[record.relation] : '');
    return record.url
      ? '<a href="' + escape(record.url) + '" title="' + escape(record.id) + '" target="_blank" rel="noopener noreferrer">' + escape(text) + '</a>'
      : escape(text);
  };
  const origin = normalized.taskOrigin.system ? normalized.taskOrigin : { system: 'unknown' };
  return '<div class="task-metadata meta"><div>Source: ' + item(origin, false) + '</div>' +
    (normalized.workflowTaskId ? '<div>Workflow: ' + escape(normalized.workflowTaskId) + '</div>' : '') +
    (normalized.taskRelations.length ? '<div class="task-relation-list"><span>Relations:</span> ' + normalized.taskRelations.map(r => '<span class="task-relation task-relation-' + escape(r.system) + '">' + item(r, true) + '</span>').join('') + '</div>' : '') + '</div>';
}

module.exports = { normalizeTaskMetadata, renderTaskMetadata };
