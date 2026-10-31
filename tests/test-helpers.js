import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { shellEscape } from "../utils.js";
import { determineReleaseTypeFromCommit, createCommitMessageParts } from "../commit-helpers.js";

export async function withWorkflowState(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-handlers-"));
  const stateFile = path.join(tempDir, "state.json");
  const state = new WorkflowState(stateFile);
  await state.load();

  try {
    await callback(state);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export const testUtils = {
  shellEscape,
  determineReleaseTypeFromCommit,
  createCommitMessageParts,
};

export function createRequest(name, args) {
  return {
    params: {
      name,
      arguments: args,
    },
  };
}

/**
 * Removes ANSI colour codes and npm's own `npm warn` / `npm notice` chatter from
 * captured stderr, leaving anything a build tool actually reported.
 *
 * npm emits these lines for user-level configuration (e.g. an .npmrc setting
 * that does not apply here). They say nothing about the build and must not make
 * a clean build look broken.
 */
export function stripNpmNotices(stderr) {
  if (!stderr) return "";

  const cleaned = String(stderr)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*npm (warn|notice)\b/.test(line))
    .join("\n");

  // Rollup annotates dependency comments it cannot interpret. It says so on
  // stderr but still emits a working bundle ("built in Xms"), so this is noise
  // from third-party code, not a build failure.
  return cleaned.replace(
    /^.*A comment\s*\n(?:.*\n)*?.*contains an annotation that Rollup cannot interpret.*\n?/gm,
    "",
  );
}

export function createGitMock(overrides = {}) {
  // SHA default yang konsisten: push dianggap berhasil kecuali test menggantinya.
  const headSha = "a".repeat(40);
  return {
    hasWorkingChanges: async () => false,
    hasStagedChanges: async () => false,
    hasTestChanges: async () => true,
    getStagedChanges: async () => [],
    getCurrentBranch: async () => "main",
    getHeadSha: async () => headSha,
    getPrimaryBranch: async () => "main",
    getRemoteBranchSha: async () => headSha,
    getLastCommitMessage: async () => "",
    getStatusOutput: async () => "",
    containsTestFilesInStatus: (statusOutput) => statusOutput.includes("tests/"),
    workingTreeSummary: () => ({ hasChanges: false, lines: [] }),
    ...overrides,
  };
}
