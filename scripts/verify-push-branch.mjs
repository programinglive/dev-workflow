// Verifikasi end-to-end commit_and_push: harus mem-push branch AKTIF.
// Memanggil handler asli (bukan mock) terhadap repo sementara + remote bare.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleToolCall } from "../tools/handlers.js";
import { WorkflowState } from "../workflow-state.js";
import { shellEscape, normalizeRequestArgs } from "../utils.js";
import { createCommitMessageParts, determineReleaseTypeFromCommit } from "../commit-helpers.js";
import { createGitFacade } from "../git-facade.js";
import { exec } from "../exec.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const root = mkdtempSync(path.join(tmpdir(), "push-verify-"));
const remote = path.join(root, "remote.git");
const work = path.join(root, "work");

try {
  git(root, "init", "--bare", "-q", remote);
  git(root, "clone", "-q", remote, work);
  git(work, "config", "user.email", "test@example.test");
  git(work, "config", "user.name", "Test");

  writeFileSync(path.join(work, "base.txt"), "awal\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "chore: initial");
  git(work, "branch", "-M", "main");
  git(work, "push", "-q", "origin", "main");

  // Branch fitur dengan commit yang BELUM di-push.
  git(work, "checkout", "-q", "-b", "feat/verifikasi");
  writeFileSync(path.join(work, "fitur.txt"), "fitur\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "feat: pekerjaan di branch fitur");

  const headBefore = git(work, "rev-parse", "HEAD");
  const mainBefore = git(work, "rev-parse", "main");

  // Perubahan yang BELUM di-commit, supaya tool menempuh jalur commit + push
  // (bukan jalur "no changes detected").
  writeFileSync(path.join(work, "belum-commit.txt"), "perubahan\n");

  console.log("branch aktif :", git(work, "branch", "--show-current"));
  console.log("HEAD awal    :", headBefore.slice(0, 8));
  let remoteFeatBefore = "(belum ada)";
  try {
    remoteFeatBefore = git(work, "rev-parse", "--verify", "-q", "origin/feat/verifikasi").slice(0, 8);
  } catch { /* belum ada */ }
  console.log("origin/feat  :", remoteFeatBefore);

  const stateFile = path.join(root, "state.json");
  const workflowState = new WorkflowState(stateFile);
  await workflowState.load();
  Object.assign(workflowState.state, {
    currentPhase: "commit",
    taskDescription: "verifikasi push branch",
    taskType: "other",
    featureFlowCreated: true,
    bugFixed: true,
    testsCreated: true,
    testsPassed: true,
    testsSkipped: true,
    documentationCreated: true,
    readyToCommit: true,
    readyCheckCompleted: true,
    commitAndPushCompleted: false,
    projectDir: work,
    history: [],
  });
  await workflowState.save();

  const response = await handleToolCall({
    request: {
      params: {
        name: "commit_and_push",
        arguments: { commitMessage: "feat: uji push", projectDir: work },
      },
    },
    normalizeRequestArgs,
    workflowState,
    exec,
    git: createGitFacade(),
    utils: { shellEscape, determineReleaseTypeFromCommit, createCommitMessageParts },
  });

  console.log("\n=== output tool ===");
  console.log(response.content[0].text);

  console.log("\n=== hasil di remote ===");
  let remoteFeat = "";
  try {
    remoteFeat = git(work, "rev-parse", "--verify", "-q", "origin/feat/verifikasi");
  } catch { /* tidak ada */ }
  const remoteMain = git(work, "rev-parse", "main");
  console.log("origin/feat/verifikasi :", remoteFeat ? remoteFeat.slice(0, 8) : "(tidak ada)");
  console.log("origin/main            :", remoteMain.slice(0, 8));

  const headAfter = git(work, "rev-parse", "HEAD");
  const okFeat = remoteFeat === headAfter;
  const okMain = remoteMain === mainBefore;
  console.log("");
  console.log(okFeat ? "BENAR: remote menerima commit di branch fitur" : "SALAH: remote/feat tidak menerima HEAD");
  console.log(okMain ? "BENAR: main tidak tersentuh" : "SALAH: main ikut berubah");
  process.exitCode = okFeat && okMain ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
