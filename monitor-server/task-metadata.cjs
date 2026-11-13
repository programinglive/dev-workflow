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
      const normalized = record(item, ['zettly', 'zettly_draw', 'factory', 'sentry', 'session_chain'], true);
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
  const names = { zettly: 'Zettly', zettly_draw: 'Zettly Draw', factory: 'Factory', sentry: 'Sentry', session_chain: 'Zettelkasten', manual: 'Manual', unknown: 'Unknown' };
  const item = (record, relation) => {
    if (record.system === 'session_chain') {
      const relNames = { preceded_by: 'Lanjutan dari', superseded_by: 'Dilanjutkan di' };
      const relLabel = relation && relNames[record.relation] ? relNames[record.relation] : 'Rujukan';
      const text = '🔗 ' + relLabel + ': ' + escape(record.label);
      return '<span class="session-chain-pill" data-session-chain="' + escape(record.id) + '" style="color:#d2a8ff;cursor:pointer;font-weight:600;">' + text + '</span>';
    }
    const prefix = names[record.system];
    const label = record.label || '';
    const shortId = record.id ? (record.system === 'factory' ? record.id.slice(0, 8) : record.id) : '';
    const named = label.startsWith(prefix + ' ') ? label : record.system === 'zettly_draw' && label.startsWith('Draw #') ? 'Zettly ' + label : prefix + (label ? (['factory', 'sentry'].includes(record.system) ? ' ' : ' · ') + label : '');
    const main = shortId && !named.includes(shortId) ? named + ' #' + shortId : named;
    const relationNames = { tracks: 'Todo', executes: 'eksekusi', visual_plan: 'rencana visual', source_issue: 'isu sumber', focus: 'fokus', preceded_by: 'Lanjutan dari', superseded_by: 'Dilanjutkan di' };
    const text = main + (relation && relationNames[record.relation] ? ' · ' + relationNames[record.relation] : '');
    return record.url
      ? '<a href="' + escape(record.url) + '" title="' + escape(record.id) + '" target="_blank" rel="noopener noreferrer">' + escape(text) + '</a>'
      : escape(text);
  };
  const origin = normalized.taskOrigin.system ? normalized.taskOrigin : { system: 'unknown' };

  const repoPath = typeof session.repo_path === 'string' ? session.repo_path.trim() : '';
  let repositoryHtml = '';
  if (repoPath) {
    // The clickable repository chip is rendered separately by the card
    // (repoLinkHtml) and already shows the remote. Printing the remote here too
    // showed the same address twice on one card, so this line carries only the
    // local path. When no path was reported the chip is the single link.
    repositoryHtml = '<div class="repo-line meta" style="margin-top:4px;color:#8b949e">📁 ' + escape(repoPath) + '</div>';
  }

  // A task card without a Mermaid flow hides the one thing the owner asked for:
  // the steps. Say it out loud instead of silently omitting the preview.
  const hasFlow = normalized.taskRelations.some((record) => record.system === 'zettly_draw');
  const taskText = String(session.task || session.session_title || '').trim();
  const flowWarning = taskText && !hasFlow
    ? '<div class="flow-missing meta" style="margin-top:4px;color:#d29922">⚠ Flow belum ada — jalankan create_feature_flow</div>'
    : '';

  let drawPreviewHtml = '';
  const drawRelation = normalized.taskRelations.find(r => r.system === 'zettly_draw');
  if (drawRelation && drawRelation.id) {
    const drawId = escape(drawRelation.id);
    const drawUrl = escape(drawRelation.url || '');
    const drawTitle = escape(drawRelation.label || ('Draw #' + drawId));
    drawPreviewHtml = '<div class="flow-preview" data-flow-id="' + drawId + '" data-flow-title="' + drawTitle + '" data-flow-url="' + drawUrl + '" style="margin-top:8px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:11px;color:#8b949e;">' +
      '<span>📐 Flow Diagram</span>' +
      (drawUrl ? '<a href="' + drawUrl + '" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;text-decoration:none;">Buka di Zettly ↗</a>' : '') +
      '</div>' +
      '<div class="flow-thumb-box" style="cursor:pointer;background:#0b1020;border:1px solid #30363d;border-radius:6px;overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;padding:4px;max-height:160px;">' +
      '<img src="/api/drawings/' + drawId + '/thumbnail" alt="' + drawTitle + '" loading="lazy" style="max-width:100%;max-height:150px;object-fit:contain;border-radius:4px;" onerror="this.parentElement.style.display=\'none\'" />' +
      '<div class="flow-thumb-hint" style="position:absolute;bottom:4px;right:6px;background:rgba(13,17,23,0.85);color:#c9d1d9;padding:2px 6px;border-radius:4px;font-size:10px;border:1px solid #30363d;pointer-events:none;">🔍 Perbesar / PNG</div>' +
      '</div>' +
      '</div>';
  }

  return '<div class="task-metadata meta"><div>Source: ' + item(origin, false) + '</div>' +
    (normalized.workflowTaskId ? '<div>Workflow: ' + escape(normalized.workflowTaskId) + '</div>' : '') +
    (normalized.taskRelations.length ? '<div class="task-relation-list"><span>Relations:</span> ' + normalized.taskRelations.map(r => '<span class="task-relation task-relation-' + escape(r.system) + '">' + item(r, true) + '</span>').join('') + '</div>' : '') +
    repositoryHtml +
    flowWarning +
    drawPreviewHtml +
    '</div>';
}

module.exports = { normalizeTaskMetadata, renderTaskMetadata };
