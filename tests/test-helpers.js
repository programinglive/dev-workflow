import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowState } from "../workflow-state.js";
import { captureRepositoryIdentity, buildIdentityContract } from "../repository-identity.js";
import { shellEscape } from "../utils.js";
import { determineReleaseTypeFromCommit, createCommitMessageParts } from "../commit-helpers.js";

/**
 * Give a test task a real, trustworthy task-to-workspace binding.
 *
 * Repository-mutating handlers now fail closed when a task has no identity
 * contract and never declared a projectDir. A unit test that exercises commit,
 * release or deployment logic must therefore establish the same binding a real
 * `start_task` would, or it is testing a state that cannot exist in production.
 */
export async function bindTaskToRepo(state, repo = null) {
  const dir = repo || path.join(path.dirname(state.stateFile), "task-repo");
  await mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  }
  const identity = await captureRepositoryIdentity({ dir });
  state.state.projectDir = dir;
  state.state.identityContract = buildIdentityContract({ identity });
  return dir;
}

export async function withWorkflowState(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-handlers-"));
  const stateFile = path.join(tempDir, "state.json");
  const state = new WorkflowState(stateFile);
  await state.load();

  try {
    await callback(state);
  } finally {
    try {
      state.db?.close?.();
      state.store?.db?.close?.();
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows SQLite WAL handle lock during temp directory cleanup
    }
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
    getTagsAtHead: async () => [],
    isCommitOnRemoteBranch: async () => false,
    getCommittedFilesSince: async () => [],
    getHeadChangedFiles: async () => [],
    ...overrides,
  };
}
