/**
 * @zettly-code DWF-TOOL-PROFILES-010
 * @purpose Estimate the prompt cost of one tool profile, so `devwf doctor` and the
 * README can show the trade-off between a small and a full catalog honestly.
 * @invariant Values are labelled estimates, not measurements. The estimator uses a
 * documented JSON-friendly heuristic (about three characters per token) because the
 * repository must not depend on a tokenizer at runtime.
 */
import { getAllToolDefinitions } from "../tools/definitions.js";
import { buildWorkflowInstructions } from "../workflow-guidance.js";
import { filterToolsByProfile, getToolProfile } from "./tool-profiles.js";

export const TOKEN_ESTIMATOR_LABEL = "estimate (about 3 characters per token)";
export const TOKEN_ESTIMATOR_CHARS_PER_TOKEN = 3;

/**
 * What a client actually receives at initialize time: the tool catalog plus the
 * server instructions. Both are profile-filtered, so both count.
 */
export function estimateToolCatalogCost(profile = getToolProfile()) {
  const allTools = getAllToolDefinitions();
  const tools = filterToolsByProfile(allTools, profile);
  const toolsJsonChars = JSON.stringify({ tools }).length;
  const instructions = buildWorkflowInstructions(profile);
  const totalChars = toolsJsonChars + instructions.length;

  return {
    profile,
    tools: tools.length,
    registeredTools: allTools.length,
    toolsJsonChars,
    instructionsChars: instructions.length,
    jsonChars: totalChars,
    descriptionChars: tools.reduce(
      (total, tool) => total + (typeof tool.description === "string" ? tool.description.length : 0),
      0,
    ),
    schemaChars: tools.reduce(
      (total, tool) => total + JSON.stringify(tool.inputSchema || {}).length,
      0,
    ),
    estimatedTokens: Math.ceil(totalChars / TOKEN_ESTIMATOR_CHARS_PER_TOKEN),
    estimator: TOKEN_ESTIMATOR_LABEL,
  };
}

/**
 * Percentage saved against the `full` catalog. Rounded to a whole number because
 * the underlying figure is an estimate.
 */
export function tokenSavingsPercent(profile) {
  const full = estimateToolCatalogCost("full").estimatedTokens;
  if (!full) return 0;
  const current = estimateToolCatalogCost(profile).estimatedTokens;
  return Math.round(((full - current) / full) * 100);
}
