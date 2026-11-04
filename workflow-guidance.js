export const ENGLISH_IMPLEMENTATION_RULE = 'English implementation rule: write new identifiers, comments, docstrings, test descriptions, developer documentation and commit messages in English. User conversation and explicitly localized product text may use the requested language; preserve existing localization.';

export const WORKFLOW_INSTRUCTIONS = `${ENGLISH_IMPLEMENTATION_RULE} Before development, call start_task with the actual task, projectDir, definitionOfDone and plan. dev-workflow is the central MCP ecosystem index: inspect its automatic 'Recommended MCP Tools' section or call recommend_mcp_tools to discover relevant MCP servers (central-gateway, pocketbase, infra-knowledge, notify, factory, zettly, clinic-helper, playwright, gcp, cloudflare, netlify, mermaid). Whenever running a build, test suite, image build, or deployment, call report_build_status so the live monitor displays what is currently being built. Track the canonical task and progress in Zettly; reuse an existing Todo for continuation. Do not substitute an idle connection or a journal-only entry for a tracked task. Keep progress and completion evidence current, and preserve other sessions.`;

const GUIDANCE_TOOLS = new Set(['start_task','get_workflow_status','continue_workflow','mark_bug_fixed','create_documentation','check_ready_to_commit','commit_and_push','sync_zettly_task']);

export function withEnglishGuidance(response,toolName) {
  if(!GUIDANCE_TOOLS.has(toolName)||typeof response?.content?.[0]?.text!=='string') return response;
  return {...response,content:[{...response.content[0],text:`${response.content[0].text}\n\n${ENGLISH_IMPLEMENTATION_RULE}`},...response.content.slice(1)]};
}
