import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState, resolveStateFile, sessionKeyFromRequest } from "../workflow-state.js";
import { resolveRequestSession } from "../session-scope.js";
import { handleToolCall } from "../tools/handlers.js";
import { normalizeRequestArgs } from "../utils.js";
import { createGitFacade } from "../git-facade.js";
import { exec } from "../exec.js";

/**
 * Identitas sesi harus datang dari tempat yang BENAR.
 *
 * Temuan 29 Okt 2026: implementasi pertama membaca `OPENCODE_SESSION_ID` dari
 * environment, padahal OpenCode tidak pernah men-set-nya. Akibatnya hampir
 * semua berkas state jatuh ke `pid-<pid>`, dan sesi yang bergantian memakai
 * satu proses MCP tetap saling menimpa - terbukti saat task "investigasi
 * probe .env" diganti task "voucher tidak bisa disimpan" milik sesi lain.
 *
 * OpenCode v2 mengirim identitas sesi sebagai request metadata:
 *   CallToolRequest.params._meta["ai.opencode/sessionID"]
 *
 * Tes ini mengunci bahwa metadata itulah yang dipakai.
 */

const SESSION_META_KEY = "ai.opencode/sessionID";

const originalCwd = process.cwd();
const originalSessionId = process.env.DEV_WORKFLOW_SESSION_ID;
const originalOpencodeSession = process.env.OPENCODE_SESSION_ID;
const originalStateFile = process.env.DEV_WORKFLOW_STATE_FILE;
const originalUserId = process.env.DEV_WORKFLOW_USER_ID;
const originalDbPath = process.env.DEV_WORKFLOW_DB_PATH;

async function withProject(callback) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "session-meta-"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: projectRoot });

  if (!process.env.DEV_WORKFLOW_DB_PATH) {
    process.env.DEV_WORKFLOW_DB_PATH = path.join(tmpdir(), `session-meta-tests-${process.pid}.db`);
  }
  delete process.env.DEV_WORKFLOW_STATE_FILE;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.DEV_WORKFLOW_SESSION_ID;
  process.env.DEV_WORKFLOW_USER_ID = "user-test";
  process.chdir(projectRoot);

  try {
    await callback(projectRoot);
  } finally {
    process.chdir(originalCwd);
    for (const [name, value] of [
      ["DEV_WORKFLOW_USER_ID", originalUserId],
      ["DEV_WORKFLOW_SESSION_ID", originalSessionId],
      ["OPENCODE_SESSION_ID", originalOpencodeSession],
      ["DEV_WORKFLOW_STATE_FILE", originalStateFile],
      ["DEV_WORKFLOW_DB_PATH", originalDbPath],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function requestWith(name, args, sessionId) {
  return {
    params: {
      name,
      arguments: args,
      ...(sessionId ? { _meta: { [SESSION_META_KEY]: sessionId } } : {}),
    },
  };
}

const context = (workflowState) => ({
  workflowState,
  exec,
  git: createGitFacade(),
  normalizeRequestArgs,
  utils: {},
});

test("sessionKeyFromRequest membaca metadata ai.opencode/sessionID", () => {
  const request = requestWith("start_task", {}, "ses_abc123");
  assert.equal(sessionKeyFromRequest(request), "ses_abc123");
});

test("sessionKeyFromRequest mengembalikan null tanpa metadata", () => {
  assert.equal(sessionKeyFromRequest(requestWith("start_task", {})), null);
  assert.equal(sessionKeyFromRequest({ params: {} }), null);
  assert.equal(sessionKeyFromRequest(null), null);
});

test("sessionKeyFromRequest mengabaikan nilai yang tidak masuk akal", () => {
  assert.equal(sessionKeyFromRequest({ params: { _meta: { [SESSION_META_KEY]: "   " } } }), null);
  assert.equal(sessionKeyFromRequest({ params: { _meta: { [SESSION_META_KEY]: 123 } } }), null);
});

test("resolveStateFile memakai session id yang diberikan", async () => {
  await withProject(async () => {
    const resolved = resolveStateFile({ sessionId: "ses_dari_metadata" });
    assert.ok(/ses_dari_metadata/.test(resolved), `path harus memuat session id, dapat: ${resolved}`);
    assert.ok(!/pid-/.test(resolved), "tidak boleh jatuh ke pid bila session id tersedia");
  });
});

test("dua sesi lewat handleToolCall tidak saling menimpa task", async () => {
  await withProject(async (projectRoot) => {
    const repoB = path.join(projectRoot, "worktree-b");
    await mkdir(repoB, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoB });
    const state = new WorkflowState();
    await state.load();

    // Sesi A memulai task.
    await handleToolCall({
      request: requestWith("start_task", { description: "Task milik sesi A", type: "feature", definitionOfDone: ["sesi A tercatat"] }, "ses_AAA"),
      ...context(state),
    });

    // Session B starts another task on a separate working tree using the same MCP process.
    await handleToolCall({
      request: requestWith(
        "start_task",
        {
          description: "Task milik sesi B",
          type: "bugfix",
          projectDir: repoB,
          allowProjectSwitch: true,
          projectSwitchReason: "Testing session B isolation on separate worktree",
          definitionOfDone: ["sesi B tercatat"],
        },
        "ses_BBB",
      ),
      ...context(state),
    });

    // Sesi A bertanya status: harus melihat task-nya sendiri, bukan task B.
    const statusA = await handleToolCall({
      request: requestWith("get_workflow_status", {}, "ses_AAA"),
      ...context(state),
    });
    const textA = statusA.content[0].text;
    assert.match(textA, /Task milik sesi A/, `sesi A harus melihat task-nya sendiri, dapat:\n${textA}`);
    assert.doesNotMatch(textA, /Task milik sesi B/, "sesi A tidak boleh melihat task sesi B");

    // Sesi B juga harus melihat task-nya sendiri.
    const statusB = await handleToolCall({
      request: requestWith("get_workflow_status", {}, "ses_BBB"),
      ...context(state),
    });
    assert.match(statusB.content[0].text, /Task milik sesi B/);
  });
});

test("tanpa metadata sesi, tool session-scoped ditolak oleh gate MCP", () => {
  const gate = resolveRequestSession(requestWith("start_task", { description: "Task tanpa metadata" }));
  assert.equal(gate.ok, false, "start_task tanpa session id harus ditolak");
  assert.match(gate.error, /SESSION_IDENTITY_REQUIRED/);
});

test("tanpa metadata sesi, tool non-session tetap diizinkan", () => {
  const gate = resolveRequestSession(requestWith("get_current_focus", {}));
  assert.equal(gate.ok, true, "get_current_focus tidak boleh butuh session id");
  assert.equal(gate.sessionId, null);
});

test("berpindah sesi memuat state sesi itu, bukan menyalin yang lama", async () => {
  await withProject(async (projectRoot) => {
    const repoY = path.join(projectRoot, "worktree-y");
    await mkdir(repoY, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoY });
    const state = new WorkflowState();
    await state.load();

    await handleToolCall({
      request: requestWith("start_task", { description: "Task sesi X", type: "feature", definitionOfDone: ["sesi X tercatat"] }, "ses_XXX"),
      ...context(state),
    });
    const fileX = state.stateFile;

    await handleToolCall({
      request: requestWith(
        "start_task",
        {
          description: "Task sesi Y",
          type: "feature",
          projectDir: repoY,
          allowProjectSwitch: true,
          projectSwitchReason: "Testing session Y isolation on separate worktree",
          definitionOfDone: ["sesi Y tercatat"],
        },
        "ses_YYY",
      ),
      ...context(state),
    });
    assert.notEqual(state.stateFile, fileX, "sesi Y harus memakai berkas berbeda");
    assert.match(state.state.taskDescription, /Task sesi Y/);

    // Kembali ke sesi X: task X harus utuh, bukan tertimpa Y.
    await handleToolCall({
      request: requestWith("get_workflow_status", {}, "ses_XXX"),
      ...context(state),
    });
    assert.equal(state.stateFile, fileX, "kembali ke sesi X harus memakai berkas X");
    assert.match(state.state.taskDescription, /Task sesi X/);
  });
});
