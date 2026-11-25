/**
 * @zettly-code DWF-TOOL-PROFILES-001
 * @purpose Single source of truth for MCP tool profiles. A profile decides which
 * canonical tools are registered by `tools/list` and which are callable through
 * `tools/call`, so a small session can pay for 18 tools instead of 65 without
 * forking the handler layer.
 * @invariant Profiles are data, not branching logic: every profile name, tool list
 * and description lives in this file. `full` resolves to every registered tool so a
 * newly added tool is never silently hidden from the default profile.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOOL_PROFILE_ENV = "DEVWF_TOOL_PROFILE";
export const DEFAULT_TOOL_PROFILE = "full";
export const TOOL_PROFILE_NAMES = Object.freeze(["core", "standard", "full"]);

/**
 * The minimum lifecycle every task needs: start a task, record the flow, prove the
 * fix, record tests, run them, document, pass the ready gate, commit, release and
 * close. Deliberately excludes every waiver/force tool so the smallest profile is
 * also the strictest one.
 */
export const CORE_TOOL_NAMES = Object.freeze([
  "start_task",
  "create_feature_flow",
  "mark_bug_fixed",
  "create_tests",
  "run_tests",
  "create_documentation",
  "check_ready_to_commit",
  "commit_and_push",
  "perform_release",
  "complete_task",
  "get_workflow_status",
  "set_plan",
  "mark_plan_step",
  "set_definition_of_done",
  "mark_dod_item",
  "acknowledge_instructions",
  "view_history",
  "drop_task",
]);

/**
 * Added by `standard`: audit/autofix, code memory, release locking and project
 * discovery. These are operational extras, never lifecycle steps.
 */
export const STANDARD_ONLY_TOOL_NAMES = Object.freeze([
  "audit",
  "analyze_change",
  "plan_fix",
  "apply_safe_fix",
  "code_index",
  "code_context",
  "acquire_release_lock",
  "release_release_lock",
  "record_deployment",
  "recommend_mcp_tools",
  "search_project",
  "project_summary",
]);

export const TOOL_PROFILES = Object.freeze({
  core: Object.freeze({
    description:
      "Task lifecycle only. Strictest profile: no waiver, force-complete, handoff or Sentry tools.",
    tools: CORE_TOOL_NAMES,
  }),
  standard: Object.freeze({
    description:
      "Core plus audit/autofix, code memory, release locking, deployment recording and project discovery.",
    tools: Object.freeze([...CORE_TOOL_NAMES, ...STANDARD_ONLY_TOOL_NAMES]),
  }),
  full: Object.freeze({
    description:
      "Every registered tool, including waivers, force-complete, handoff, focus and Sentry integration. Default.",
    tools: null,
  }),
});

export function isKnownToolProfile(value) {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TOOL_PROFILES, value.trim().toLowerCase())
  );
}

let fileProfileCache;
let fileProfileLoaded = false;

/**
 * `devwf setup --profile` records the choice in `~/.devworkflow/profile.json`.
 * The environment variable still wins so one shell can override a machine-wide
 * default without rewriting the profile file.
 */
export function readProfileFileToolProfile(env = process.env) {
  if (fileProfileLoaded) return fileProfileCache;
  fileProfileLoaded = true;
  try {
    const override = typeof env.DEVWF_PROFILE_DIR === "string" ? env.DEVWF_PROFILE_DIR.trim() : "";
    const dir = override ? path.resolve(override) : path.join(os.homedir(), ".devworkflow");
    const file = path.join(dir, "profile.json");
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (isKnownToolProfile(data?.toolProfile)) {
        fileProfileCache = data.toolProfile.trim().toLowerCase();
      }
    }
  } catch {
    fileProfileCache = undefined;
  }
  return fileProfileCache;
}

export function resetToolProfileCache() {
  fileProfileCache = undefined;
  fileProfileLoaded = false;
}

/**
 * Resolve an explicit or environment-provided profile. Unknown or empty values
 * fall back to `full` so a typo can never lock a session out of its tools; callers
 * that want to surface the typo should compare with `isKnownToolProfile`.
 */
export function resolveToolProfile(raw) {
  if (typeof raw === "string" && isKnownToolProfile(raw)) {
    return raw.trim().toLowerCase();
  }
  return DEFAULT_TOOL_PROFILE;
}

export function getToolProfile(raw = process.env[TOOL_PROFILE_ENV]) {
  if (typeof raw === "string" && raw.trim()) return resolveToolProfile(raw);
  return readProfileFileToolProfile() || DEFAULT_TOOL_PROFILE;
}

export function toolsForProfile(profile = getToolProfile()) {
  const definition = TOOL_PROFILES[resolveToolProfile(profile)];
  return definition.tools ? new Set(definition.tools) : null;
}

/**
 * `null` means "no restriction" (full profile), not "empty set".
 */
export function isToolAllowedInProfile(toolName, profile = getToolProfile()) {
  const allowed = toolsForProfile(profile);
  return allowed === null || allowed.has(toolName);
}

export function isToolAvailable(toolName, profile = getToolProfile()) {
  return isToolAllowedInProfile(toolName, profile);
}

export function filterToolsByProfile(tools, profile = getToolProfile()) {
  const allowed = toolsForProfile(profile);
  if (allowed === null) return tools;
  return tools.filter((tool) => allowed.has(tool.name));
}

export function profileToolCount(profile = getToolProfile(), totalRegistered = null) {
  const definition = TOOL_PROFILES[resolveToolProfile(profile)];
  if (definition.tools) return definition.tools.length;
  return totalRegistered;
}

export function availableProfiles() {
  return TOOL_PROFILE_NAMES.map((name) => ({
    name,
    description: TOOL_PROFILES[name].description,
    tools: TOOL_PROFILES[name].tools ? TOOL_PROFILES[name].tools.length : null,
  }));
}

export function unavailabilityMessage(toolName, profile = getToolProfile()) {
  const active = resolveToolProfile(profile);
  const count = profileToolCount(active);
  const current = count ? ` (${count} tools)` : "";
  const alternatives = TOOL_PROFILE_NAMES.filter((name) => name !== active)
    .map((name) => {
      const size = profileToolCount(name);
      return `DEVWF_TOOL_PROFILE=${name}${size ? ` (${size} tools)` : " (all tools)"}`;
    })
    .join(" or ");
  return (
    `⚠️ Tool '${toolName}' is not available in profile '${active}'${current}.\n\n` +
    `Switch profile with ${alternatives}, then restart the MCP server. ` +
    `Set ${TOOL_PROFILE_ENV}=full to expose every tool.`
  );
}

