import { textResponse } from './shared.js';
import { searchProject, MAX_QUERY_CHARS, MAX_RESULTS } from '../../search-project.js';

export async function handleSearchProject(args, workflowState) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) return textResponse("⚠️ 'query' must be a non-empty plain-text question or phrase.");
  if (query.length > MAX_QUERY_CHARS) {
    return textResponse(`⚠️ 'query' must be at most ${MAX_QUERY_CHARS} characters.`);
  }

  const limit = args.limit === undefined ? 8 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    return textResponse(`⚠️ 'limit' must be an integer from 1 to ${MAX_RESULTS}.`);
  }

  const projectDir = workflowState?.state?.projectDir;
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    return textResponse('⚠️ No active project is pinned. Start a workflow task with projectDir first.');
  }

  let result;
  try {
    result = await searchProject({ projectDir, query, limit });
  } catch (error) {
    return textResponse(`⚠️ Project search unavailable: ${error.message || 'repository could not be searched safely'}.`);
  }

  const heading = 'Local lexical search (read-only; no persistent index or network calls).';
  if (result.hits.length === 0) {
    const notices = [];
    if (result.skipped > 0) notices.push(`${result.skipped} protected, binary, or unreadable files skipped`);
    if (result.truncated) notices.push('scan limits reached; results may be incomplete');
    return textResponse(`${heading}\nNo matching lines found.${notices.length ? `\n${notices.join('; ')}.` : ''}`);
  }

  const citations = result.hits.map((hit) => `- ${hit.path}:${hit.line}\n  ${hit.text}`);
  const notices = [];
  if (result.skipped > 0) notices.push(`${result.skipped} protected, binary, or unreadable files skipped`);
  if (result.truncated) notices.push('output or scan limits reached; results may be incomplete');
  const footer = notices.length ? `\n\n${notices.join('; ')}.` : '';
  return textResponse(`${heading}\n${citations.join('\n')}\n\nRanking is lexical: exact phrase first, then query-term overlap.${footer}`);
}
