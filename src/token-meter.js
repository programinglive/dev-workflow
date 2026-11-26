/**
 * @zettly-code DWF-TOKEN-METER-001
 * @purpose Measure the server's own prompt contribution: the active tool catalog, server instructions, and tool response characters for one process. The server cannot see the client's system prompt, total session tokens, or model output; every figure is an estimate range, not a measurement of the whole session.
 */
import { getAllToolDefinitions, getToolList } from "../tools/definitions.js";
import { buildWorkflowInstructions } from "../workflow-guidance.js";
import { filterToolsByProfile, getToolProfile } from "./tool-profiles.js";

export function estimateTokens(chars) {
  const value = Math.max(0, Math.ceil(Number(chars) || 0));
  return { low: Math.ceil(value / 4), high: Math.ceil(value / 3) };
}

export function formatTokenRange(chars) {
  const { low, high } = estimateTokens(chars);
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  return `${k(low)}-${k(high)}`;
}

export function catalogChars(profile = getToolProfile()) {
  const tools = filterToolsByProfile(getAllToolDefinitions(), profile);
  return JSON.stringify(tools).length;
}

export function instructionChars(profile = getToolProfile()) {
  return buildWorkflowInstructions(profile).length;
}

export function profileTokenReport(profile = getToolProfile()) {
  const tools = filterToolsByProfile(getAllToolDefinitions(), profile);
  const chars = JSON.stringify(tools).length;
  return {
    profile,
    tools: tools.length,
    catalogChars: chars,
    catalog: estimateTokens(chars),
    instructionChars: instructionChars(profile),
    instructions: estimateTokens(instructionChars(profile)),
  };
}

export function topTools(profile = getToolProfile(), limit = 10) {
  return filterToolsByProfile(getAllToolDefinitions(), profile)
    .map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit);
}

const session = { calls: 0, chars: 0, byTool: new Map() };

export function recordToolResponse(name, response) {
  try {
    const items = Array.isArray(response?.content) ? response.content : [];
    let chars = 0;
    for (const item of items) {
      if (item?.type === "text" && typeof item.text === "string") chars += item.text.length;
    }
    if (!chars) return;
    session.calls += 1;
    session.chars += chars;
    const key = String(name || "unknown");
    session.byTool.set(key, (session.byTool.get(key) || 0) + chars);
  } catch {
    // Instrumentation must never fail a tool call.
  }
}

export function getSessionUsage() {
  const byTool = [...session.byTool.entries()]
    .map(([name, chars]) => ({ name, chars }))
    .sort((a, b) => b.chars - a.chars);
  return { calls: session.calls, chars: session.chars, byTool };
}

export function resetSessionUsage() {
  session.calls = 0;
  session.chars = 0;
  session.byTool.clear();
}
