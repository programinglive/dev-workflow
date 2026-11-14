/**
 * Repository identity contract and preflight guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 13 November 2026 a session pinned to DBPinball accepted a Clinic task and
 * replaced its own active task. The working directory never changed and no
 * cross-project commit was made, so the defect was not in git: `start_task`
 * resolved the requested `projectDir` and never compared it with the repository
 * the session had already established. A natural-language task description was
 * enough to move the session to another project.
 *
 * This module is the single, reusable policy for that comparison. It is
 * deliberately pure where it can be: the decision (`evaluateProjectSwitch`) is
 * separated from the observation (`captureRepositoryIdentity`) so the rule can
 * be tested without a filesystem, and the observation can be reused by any
 * handler that needs to know which repository it is about to touch.
 *
 * It lives in the orchestration layer, not in a project repository. A project
 * cannot enforce a rule about "which project am I" - only the layer that owns
 * `start_task` and focus selection can.
 */

import { exec as execCallback } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Canonical form of a repository path.
 *
 * Windows paths are case-insensitive, so they are lowercased; POSIX paths are
 * not, so they keep their case. Separators are normalised to `/` and a trailing
 * separator is removed, so `D:\Code\Alpha\` and `d:/code/alpha` compare equal on
 * Windows without making `/repo/Alpha` equal to `/repo/alpha` on Linux.
 */
export function normalizeRepoPath(value) {
  const raw = text(value);
  if (!raw) return "";
  let resolved = path.resolve(raw);
  if (existsSync(resolved)) {
    try {
      resolved = typeof realpathSync.native === "function"
        ? realpathSync.native(resolved)
        : realpathSync(resolved);
    } catch {}
  }
  resolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  if (resolved === "") resolved = "/";
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Normalise a git remote URL to a stable `host/owner/repo` key.
 *
 * Handles the three forms git actually stores: scp-like (`git@host:owner/repo`),
 * URL (`https://`, `ssh://`, `git://`) and a trailing `.git`. Returns `null` for
 * an empty or unparseable value, so a local-path remote is never mistaken for a
 * hosted identity.
 */
export function parseRemoteIdentity(url) {
  const raw = text(url);
  if (!raw) return null;

  let host = "";
  let repoPath = "";

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    if (!scp) return null;
    host = scp[1];
    repoPath = scp[2];
  }

  repoPath = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

  if (!host || !repoPath) return null;

  return {
    host: host.toLowerCase(),
    path: repoPath,
    key: `${host}/${repoPath}`.toLowerCase(),
  };
}

function defaultExec(command, options) {
  return new Promise((resolve, reject) => {
    execCallback(command, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function quote(value) {
  const raw = String(value || "");
  if (process.platform === "win32") return `"${raw.replace(/"/g, '\\"')}"`;
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

const EMPTY_IDENTITY = Object.freeze({
  isGitRepo: false,
  root: "",
  remote: "",
  remotes: [],
  branch: null,
  head: null,
  detached: false,
  worktree: false,
  commonDir: "",
});

/**
 * Observe the repository identity of `dir`.
 *
 * Never throws: a directory that is not a git repository, a missing `git`
 * binary or a failing command all produce `isGitRepo: false`. A guard that
 * crashes on a broken repository would be worse than no guard, because it would
 * block every task in that repository.
 *
 * Multiple remotes are all captured; `origin` is the identity when present,
 * because that is the remote a clone and a push actually use. A linked worktree
 * is reported as `worktree: true` but keeps the same remote identity, so it is
 * the same repository for the purpose of this guard.
 */
export async function captureRepositoryIdentity({ dir, execImpl = defaultExec } = {}) {
  const target = text(dir);
  if (!target) return { ...EMPTY_IDENTITY };

  const run = async (args) => {
    try {
      const result = await execImpl(`git -C ${quote(target)} ${args}`, { timeout: 5000 });
      return text(result && result.stdout);
    } catch {
      return "";
    }
  };

  const root = await run("rev-parse --show-toplevel");
  if (!root) return { ...EMPTY_IDENTITY };

  const remoteNames = (await run("remote")).split(/\r?\n/).map(text).filter(Boolean);
  const remotes = [];
  for (const name of remoteNames) {
    const url = await run(`remote get-url ${name}`);
    if (!url) continue;
    const parsed = parseRemoteIdentity(url);
    remotes.push({ name, url, key: parsed ? parsed.key : "" });
  }

  const origin = remotes.find((entry) => entry.name === "origin") || remotes[0] || null;
  const branch = await run("symbolic-ref -q --short HEAD");
  const head = await run("rev-parse HEAD");
  const commonDirRaw = await run("rev-parse --git-common-dir");

  const resolvedRoot = (normalizeRepoPath(target) === normalizeRepoPath(root))
    ? target
    : path.resolve(root);
  const commonDir = commonDirRaw ? path.resolve(target, commonDirRaw) : "";
  const worktree = Boolean(commonDir) && normalizeRepoPath(commonDir) !== normalizeRepoPath(path.join(resolvedRoot, ".git"));

  return {
    isGitRepo: true,
    root: resolvedRoot,
    remote: origin ? origin.url : "",
    remotes,
    branch: branch || null,
    head: head || null,
    detached: !branch,
    worktree,
    commonDir,
    // Workspace identity: this exact checkout. Two clones of one remote have
    // different workspace keys even though their repository key is equal.
    workspaceKey: normalizeRepoPath(resolvedRoot),
    // Checkout-family identity: the main checkout and all its linked worktrees
    // share one common git directory. This is what makes a worktree a
    // legitimate continuation rather than a workspace switch.
    commonDirKey: commonDir ? normalizeRepoPath(commonDir) : "",
  };
}

/**
 * Repository identity only: the normalized remote, or a local path when the
 * repository has no remote.
 *
 * NEVER use this to authorize a workspace switch. Two independently writable
 * clones of the same remote share this key, and moving a task between them is a
 * workspace change that needs authorization. Use `compareIdentity` for that
 * decision.
 */
export function sameRepository(a, b) {
  if (!a || !b) return false;
  const aKey = repositoryKeyOf(a);
  const bKey = repositoryKeyOf(b);
  return Boolean(aKey) && aKey === bKey;
}

function repositoryKeyOf(value) {
  if (!value) return "";
  if (text(value.repoKey)) return text(value.repoKey);
  const parsed = parseRemoteIdentity(value.remote);
  if (parsed) return parsed.key;
  const root = normalizeRepoPath(value.root || value.projectDir || "");
  return root ? `local:${root}` : "";
}

/**
 * Classify the relationship between a requested checkout and the session's
 * established checkout.
 *
 * The three identities are deliberately separate:
 *
 *   repository  - the normalized remote. Shared by every clone.
 *   workspace   - this exact checkout directory.
 *   checkout family - the main checkout plus its linked worktrees, which share
 *                     one git common directory.
 *
 * A matching remote alone is NOT enough to continue: two clones are separately
 * writable, so moving between them is a workspace switch. A worktree of the same
 * checkout family IS a continuation, because it shares the same object store and
 * refs and is the documented way to run a second session on one repository.
 */
export function compareIdentity(requested, session) {
  const empty = {
    match: "UNKNOWN",
    sameWorkspace: false,
    sameCheckoutFamily: false,
    sameRepository: false,
  };
  if (!requested || !session) return empty;

  const requestedWorkspace = normalizeRepoPath(requested.workspaceKey || requested.root || requested.projectDir || "");
  const sessionWorkspace = normalizeRepoPath(session.workspaceKey || session.root || session.projectDir || "");
  if (requestedWorkspace && sessionWorkspace && requestedWorkspace === sessionWorkspace) {
    return { match: "SAME_WORKSPACE", sameWorkspace: true, sameCheckoutFamily: true, sameRepository: true };
  }

  const requestedFamily = normalizeRepoPath(requested.commonDirKey || requested.commonDir || "");
  const sessionFamily = normalizeRepoPath(session.commonDirKey || session.commonDir || "");
  if (requestedFamily && sessionFamily && requestedFamily === sessionFamily) {
    return { match: "SAME_CHECKOUT_FAMILY", sameWorkspace: false, sameCheckoutFamily: true, sameRepository: true };
  }

  const requestedRepo = repositoryKeyOf(requested);
  const sessionRepo = repositoryKeyOf(session);
  if (requestedRepo && sessionRepo && requestedRepo === sessionRepo) {
    return { match: "SAME_REPOSITORY_DIFFERENT_CLONE", sameWorkspace: false, sameCheckoutFamily: false, sameRepository: true };
  }

  return { match: "DIFFERENT_REPOSITORY", sameWorkspace: false, sameCheckoutFamily: false, sameRepository: false };
}

/**
 * Decide whether a task may start in `requested` given the session's
 * established `session` project.
 *
 * The rule is intentionally narrow: the first task in a session is always
 * allowed, and a task in the same repository is always allowed. Only a genuine
 * cross-project move needs authorization, and that authorization must be
 * explicit, reasoned and focused - three separate signals, so a single
 * accidental flag cannot move a session to another project.
 */
export function evaluateProjectSwitch({
  requested,
  session,
  allowProjectSwitch = false,
  projectSwitchReason = "",
  allowWorkspaceTransition = false,
  workspaceTransitionReason = "",
  focusId = null,
} = {}) {
  if (!session || !text(session.projectDir || session.root)) {
    return { ok: true, switched: false, code: "NO_SESSION_PROJECT", match: "NO_SESSION_PROJECT" };
  }

  const comparison = compareIdentity(requested, session);

  if (comparison.match === "SAME_WORKSPACE") {
    return { ok: true, switched: false, code: comparison.match, match: comparison.match, comparison };
  }

  // A linked worktree shares one object store, but it is a second writable tree.
  // Starting a task there is a workspace transition, not automatic continuity:
  // it needs an explicit, reasoned decision so two trees never share mutable
  // task ownership by accident.
  if (comparison.match === "SAME_CHECKOUT_FAMILY") {
    if (allowWorkspaceTransition === true && text(workspaceTransitionReason).length >= 10) {
      return {
        ok: true,
        switched: true,
        code: "WORKSPACE_TRANSITION_AUTHORIZED",
        match: comparison.match,
        comparison,
      };
    }
    return {
      ok: false,
      switched: false,
      code: "WORKSPACE_TRANSITION_REQUIRES_AUTHORIZATION",
      match: comparison.match,
      comparison,
      message:
        `⚠️ Refused: this session works in a different worktree of the same repository.\n\n` +
        `Established workspace: ${text(session.projectDir || session.root)}\n` +
        `Requested workspace:   ${text(requested && (requested.root || requested.projectDir))}\n\n` +
        `The two directories share one git object store, but they are two writable trees. ` +
        `Starting here without an explicit transition would let both trees share mutable task ownership.\n\n` +
        `If this is intended, repeat 'start_task' with:\n` +
        `  allowWorkspaceTransition: true\n` +
        `  workspaceTransitionReason: "<why this task belongs in the other worktree>"\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`,
    };
  }

  const from = text(session.projectDir);
  const to = text(requested && (requested.root || requested.projectDir));

  // Same remote, different clone. Two clones are independently writable, so this
  // is a workspace switch even though the repository provider is the same.
  if (comparison.match === "SAME_REPOSITORY_DIFFERENT_CLONE" && allowProjectSwitch !== true) {
    return {
      ok: false,
      switched: false,
      code: "WORKSPACE_SWITCH_REQUIRES_AUTHORIZATION",
      match: comparison.match,
      comparison,
      message:
        `⚠️ Refused: this session works in a different checkout of the same repository.\n\n` +
        `Established workspace: ${from}\n` +
        `Requested workspace:   ${to}\n\n` +
        `The remote matches, but these are two independently writable clones. ` +
        `Continuing here would leave one clone's work and write into another.\n\n` +
        `Use a linked worktree of the established checkout to run a second session ` +
        `(shares one object store and refs), or repeat 'start_task' with:\n` +
        `  allowProjectSwitch: true\n` +
        `  projectSwitchReason: "<why this session must move>"\n` +
        `  focusId: <the focus that owns the new workspace>\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`,
    };
  }

  if (allowProjectSwitch !== true) {
    return {
      ok: false,
      switched: false,
      code: "PROJECT_SWITCH_REQUIRES_AUTHORIZATION",
      match: comparison.match,
      comparison,
      message:
        `⚠️ Refused: this session is already working in a different repository.\n\n` +
        `Established project: ${from}\n` +
        `Requested project:   ${to}\n\n` +
        `A task description is not proof of which repository it belongs to. ` +
        `Starting here would replace the active task and move the session to another project.\n\n` +
        `If this is genuinely intended, repeat 'start_task' with:\n` +
        `  allowProjectSwitch: true\n` +
        `  projectSwitchReason: "<why this session must move>"\n` +
        `  focusId: <the focus that owns the new project>\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`,
    };
  }

  if (text(projectSwitchReason).length < 10) {
    return {
      ok: false,
      switched: false,
      code: "PROJECT_SWITCH_REASON_REQUIRED",
      match: comparison.match,
      comparison,
      message:
        `⚠️ Refused: a cross-project switch needs a written reason.\n\n` +
        `Established project: ${from}\n` +
        `Requested project:   ${to}\n\n` +
        `Pass 'projectSwitchReason' with at least 10 characters explaining why this session ` +
        `must leave its current project.\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`,
    };
  }

  const focus = Number(focusId);
  if (!Number.isSafeInteger(focus) || focus <= 0) {
    return {
      ok: false,
      switched: false,
      code: "FOCUS_REQUIRED_FOR_PROJECT_SWITCH",
      match: comparison.match,
      comparison,
      message:
        `⚠️ Refused: a cross-project switch needs an explicit 'focusId'.\n\n` +
        `Established project: ${from}\n` +
        `Requested project:   ${to}\n\n` +
        `Without an explicit focus the new task would silently attach to the current focus, ` +
        `which belongs to the project this session is leaving.\n\n` +
        `Task NOT started; the previous task and its evidence are unchanged.`,
    };
  }

  return { ok: true, switched: true, code: "PROJECT_SWITCH_AUTHORIZED", match: comparison.match, comparison };
}

/**
 * Shape validation for a recorded identity contract.
 *
 * A contract that exists but is unreadable is NOT the same as a legacy task
 * without one: it means the record was corrupted or written by an older shape,
 * and treating it as "legacy" would replay the fail-open this module exists to
 * close.
 */
export function validateContractShape(contract) {
  if (contract === undefined || contract === null) return { valid: false, reason: "MISSING" };
  if (typeof contract !== "object" || Array.isArray(contract)) return { valid: false, reason: "MALFORMED" };

  const repository = contract.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    return { valid: false, reason: "MALFORMED" };
  }
  if (!text(repository.root)) return { valid: false, reason: "MALFORMED" };

  return { valid: true, reason: "VALID" };
}

/**
 * Build an identity contract for a task that predates contracts.
 *
 * This is a *validated* backfill, not a fabrication: it only reuses evidence the
 * task itself already recorded (`state.repository.path` and
 * `state.repository.remote`, captured by `save()` while the task ran) and only
 * when that evidence agrees with the live checkout. A contradiction means the
 * identity cannot be proven, and the caller must refuse.
 */
export function buildBackfillContract({ state, actual } = {}) {
  const recorded = state && state.repository;
  const recordedPath = text(recorded && recorded.path);
  const declaredProjectDir = text(state && state.projectDir);
  const recordedRemote = text(recorded && recorded.remote);
  const hasRecordedRemote = Boolean(recorded) && typeof recorded.remote === "string";

  // Two independent records of the same task must not disagree. A conflict is
  // evidence of tampering or a half-migrated state, not something to average.
  if (recordedPath && declaredProjectDir && normalizeRepoPath(recordedPath) !== normalizeRepoPath(declaredProjectDir)) {
    return { ok: false, code: "IDENTITY_UNVERIFIABLE_CONFLICT" };
  }

  // The task's own declared workspace is valid evidence: it is what the task
  // said it owns. `state.repository` is preferred because it was captured while
  // the task ran, but a task that predates that capture still declared a
  // projectDir, and the live checkout at that path is its identity.
  const evidencePath = recordedPath || declaredProjectDir;
  if (!evidencePath) {
    return { ok: false, code: "IDENTITY_UNVERIFIABLE_NO_EVIDENCE" };
  }
  if (!actual || !actual.isGitRepo) {
    return { ok: false, code: "IDENTITY_UNVERIFIABLE_NOT_A_REPO" };
  }
  if (normalizeRepoPath(evidencePath) !== normalizeRepoPath(actual.root)) {
    return { ok: false, code: "IDENTITY_UNVERIFIABLE_WORKSPACE_MISMATCH" };
  }
  if (hasRecordedRemote && recordedRemote !== text(actual.remote)) {
    return { ok: false, code: "IDENTITY_UNVERIFIABLE_REMOTE_MISMATCH" };
  }

  const parsed = parseRemoteIdentity(actual.remote);
  const focusId = Number(state && state.focus && state.focus.id);
  const contract = buildIdentityContract({
    projectId: parsed ? parsed.key : path.basename(actual.root),
    identity: actual,
    focusId: Number.isSafeInteger(focusId) && focusId > 0 ? focusId : null,
  });

  return {
    ok: true,
    contract: {
      ...contract,
      backfilled: true,
      backfilledAt: new Date().toISOString(),
      backfilledFrom: recordedPath ? "state.repository" : "state.projectDir",
    },
  };
}

/**
 * Decide whether a repository-mutating operation may proceed.
 *
 * MUTATION POLICY (stricter than task start):
 *   - the task must be running in the EXACT workspace it started in;
 *   - a linked worktree of the same checkout family is NOT sufficient, because
 *     two worktrees are two writable trees and sharing mutable task ownership
 *     between them is how one tree's work silently lands in another;
 *   - a task without a valid contract is backfilled only from verified evidence,
 *     and refused when that evidence is missing or contradicts the live checkout.
 */
export function evaluateMutationIdentity({ contract, state, actual, operation = "this operation" } = {}) {
  const shape = validateContractShape(contract);

  if (!shape.valid) {
    const backfill = buildBackfillContract({ state, actual });
    if (backfill.ok) {
      return {
        ok: true,
        code: "IDENTITY_BACKFILLED",
        backfilledContract: backfill.contract,
        comparison: { match: "SAME_WORKSPACE" },
      };
    }
    return {
      ok: false,
      code: shape.reason === "MISSING" ? "IDENTITY_UNVERIFIABLE_NO_CONTRACT" : "IDENTITY_CONTRACT_MALFORMED",
      detail: backfill.code,
      message:
        `⚠️ Refused: ${operation} needs a verifiable repository identity.\n\n` +
        (shape.reason === "MISSING"
          ? `This task was started before identity contracts existed and has no recorded repository.\n`
          : `This task's identity contract is malformed and cannot be trusted.\n`) +
        `The recorded evidence (${backfill.code}) does not prove which checkout this task owns.\n\n` +
        `A missing or unreadable identity is not permission to write. Start the task again in the ` +
        `intended repository so a contract is recorded.\n\n` +
        `Nothing was changed.`,
    };
  }

  const comparison = compareIdentity(actual, contract.repository);

  if (comparison.match === "SAME_WORKSPACE") {
    return { ok: true, code: comparison.match, comparison };
  }

  if (comparison.match === "SAME_CHECKOUT_FAMILY") {
    return {
      ok: false,
      code: "WORKTREE_WRITE_REQUIRES_TRANSITION",
      comparison,
      message:
        `⚠️ Refused: ${operation} would write into a different worktree of this repository.\n\n` +
        `Task workspace:      ${contract.repository.root}\n` +
        `Requested workspace: ${actual && actual.root ? actual.root : "(unknown)"}\n\n` +
        `The two directories share one git object store, but they are two writable trees. ` +
        `Sharing mutable task ownership between them lets one tree's work land in the other.\n\n` +
        `Start a new task in the target worktree (that records a new identity contract), ` +
        `or run this operation in the worktree it started in.\n\n` +
        `Nothing was changed.`,
    };
  }

  return {
    ok: false,
    code: comparison.match,
    comparison,
    message:
      `⚠️ Refused: ${operation} would run in a different workspace than this task started in.\n\n` +
      `Task workspace:      ${contract.repository.root}\n` +
      `Requested workspace: ${actual && (actual.root || actual.projectDir) ? actual.root || actual.projectDir : "(unknown)"}\n\n` +
      `A task is bound to the checkout it started in. Committing or releasing in another ` +
      `checkout would write into a repository this task never declared.\n\n` +
      `Start a new task in the target repository.\n` +
      `Nothing was changed.`,
  };
}

/**
 * Legacy-compatible wrapper used by the mutation handlers.
 *
 * Kept because it is the single call site for "may this mutation run here", but
 * the fail-open branch is gone: an unverifiable identity now refuses.
 */
export function assertTaskRepository({ contract, state, actual, operation = "this operation" } = {}) {
  return evaluateMutationIdentity({ contract, state, actual, operation });
}

/**
 * The identity contract recorded on a task.
 *
 * It is the answer to "what was this task allowed to touch", written once at
 * `start_task` so a later operation can compare against it instead of guessing
 * from the task text.
 */
export function buildIdentityContract({
  projectId = "",
  identity = {},
  focusId = null,
  allowedScope = [],
  forbiddenScope = [],
  allowedOperations = [],
} = {}) {
  const parsed = parseRemoteIdentity(identity.remote);
  const repoKey = parsed ? parsed.key : "";
  const root = text(identity.root);

  return {
    projectId: text(projectId) || repoKey || path.basename(root) || "",
    repository: {
      root,
      remote: text(identity.remote),
      repoKey,
      branch: identity.branch || null,
      head: identity.head || null,
      detached: Boolean(identity.detached),
      worktree: Boolean(identity.worktree),
      commonDir: text(identity.commonDir),
      commonDirKey: text(identity.commonDirKey),
      workspaceKey: text(identity.workspaceKey) || normalizeRepoPath(root),
    },
    focusId: Number.isSafeInteger(Number(focusId)) && Number(focusId) > 0 ? Number(focusId) : null,
    allowedScope: Array.isArray(allowedScope) ? allowedScope.map(text).filter(Boolean) : [],
    forbiddenScope: Array.isArray(forbiddenScope) ? forbiddenScope.map(text).filter(Boolean) : [],
    allowedOperations: Array.isArray(allowedOperations) ? allowedOperations.map(text).filter(Boolean) : [],
    recordedAt: new Date().toISOString(),
  };
}
