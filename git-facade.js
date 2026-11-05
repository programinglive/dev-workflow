/**
 * The single place that decides which git helpers are exposed to tool handlers.
 *
 * Handlers call `context.git.<helper>`. When a helper exists in git-helpers.js
 * but is forgotten here, the tool fails at runtime with
 * "git.getStatusOutput is not a function" — a wiring bug the unit tests miss
 * because their mocks provide everything. Keeping the facade in its own module
 * lets a test compare it against what the handlers actually call.
 */

import {
  getCurrentBranch,
  getHeadSha,
  getLastCommitMessage,
  getPrimaryBranch,
  getRemoteBranchSha,
  getStagedChanges,
  getStatusOutput,
  getToplevel,
  getLastCommitForPath,
  inspectCommitDiff,
  hasStagedChanges,
  hasTestChanges,
  hasWorkingChanges,
  foreignDirtyEntries,
  hasOnlyForeignChanges,
  parseStatusEntries,
  workingTreeSummary,
  getTagsAtHead,
  isCommitOnRemoteBranch,
  getCommittedFilesSince,
  getHeadChangedFiles,
} from "./git-helpers.js";

export function createGitFacade() {
  return {
    hasWorkingChanges,
    hasTestChanges,
    hasStagedChanges,
    getStagedChanges,
    getCurrentBranch,
    getHeadSha,
    getPrimaryBranch,
    getRemoteBranchSha,
    getLastCommitMessage,
    getStatusOutput,
    getToplevel,
    getLastCommitForPath,
    inspectCommitDiff,
    workingTreeSummary,
    parseStatusEntries,
    foreignDirtyEntries,
    hasOnlyForeignChanges,
    getTagsAtHead,
    isCommitOnRemoteBranch,
    getCommittedFilesSince,
    getHeadChangedFiles,
  };
}
