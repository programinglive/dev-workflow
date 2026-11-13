/**
 * One operating-system process that tries to claim a focus.
 *
 * Used by the cross-process concurrency test. It must be a real child process,
 * not an async task in the parent: the claim is protected by an OS-level
 * exclusive file create, and only separate processes exercise that guarantee.
 *
 *   node focus-claim-worker.mjs <stateFile> <focusId> <projectDir> <repoKey>
 *
 * Prints the claim result as JSON on stdout.
 */
import { claimFocusBinding } from "../../workflow-state.js";

const [stateFile, focusId, projectDir, repoKey] = process.argv.slice(2);

const result = await claimFocusBinding({
  stateFile,
  focusId: Number(focusId),
  projectDir,
  repoKey,
});

process.stdout.write(JSON.stringify(result));
