import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { textResponse } from "./shared.js";
import { summarize as summarizeDod, renderOutstanding } from "./dod.js";
import { planProgress } from "./plan.js";
import { DEFAULT_LOCK_STALE_MS, acquireWorktreeMutex, releaseWorktreeMutex, resolveCanonicalWorktreeRoot } from "../../process-lock.js";
import { readHandshake, readClaim, markClaimAdopted } from "../../monitor-server/restart-handshake-store.cjs";
import { createLocalAdapters } from "../../session-controller-adapters.js";
import { resolveProjectDir } from "../../exec.js";
import { stateFingerprint } from "../../monitor-server/restart-handshake.cjs";
import { revalidatePreflight, runPreflight } from "../../preflight.js";

/**
 * Reconnect ke state sesi lain yang tertinggal.
 *
 * MENGAPA PERLU
 * -------------
 * State disimpan per sesi, jadi sesi yang ditutup meninggalkan pekerjaannya di
 * disk: fase, bukti DoD, dan rencana. Sesi baru mulai dari nol dan tidak bisa
 * melihatnya. Diukur 1 November 2026: satu state tertinggal di fase `release`
 * dengan task "Perbaiki pilot produksi belajar" - tidak terbaca siapa pun,
 * sementara sesi baru mengira tidak ada apa-apa.
 *
 * ATURAN KESELAMATAN
 * ------------------
 * - Hanya dari PROYEK yang sama. Menyeberangkan task antar proyek persis
 *   kesalahan yang fitur isolasi state perbaiki.
 * - Tidak pernah mengambil task yang pemiliknya masih hidup DAN baru menulis
 *   state. Menyalin pekerjaan sesi yang sedang berjalan adalah kehilangan data
 *   dengan arah berlawanan.
 * - Berkas sumber tidak dihapus. Adopsi adalah SALINAN, bukan pemindahan; jejak
 *   aslinya tetap ada untuk diperiksa.
 * - Hanya boleh bila sesi ini belum punya task berjalan.
 */

const STATE_FILE_PATTERN = /^workflow-state\.(.+)\.json$/;

function projectDirFromStateFile(stateFile) {
  const resolved = path.resolve(stateFile);
  const segments = resolved.split(path.sep);
  const projectsIndex = segments.lastIndexOf("projects");
  if (projectsIndex >= 0 && segments.length > projectsIndex + 2) {
    return segments.slice(0, projectsIndex + 2).join(path.sep);
  }
  // Per-project layout without a `projects` segment:
  //   <base>/users/<user>/workflow-state.<key>.json
  // Falling back to dirname() here pointed the scan at
  // `<base>/users/<user>/users`, which never exists, so no candidate was ever
  // found and an adoption of a handover in this layout failed.
  const usersIndex = segments.lastIndexOf("users");
  if (usersIndex > 0) {
    return segments.slice(0, usersIndex).join(path.sep);
  }
  return path.dirname(resolved);
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a reloaded state is the task that was adopted.
 *
 * A matching description alone is not enough: two different tasks can share a
 * description, and the point of the check is to prove the store holds the
 * adopted task, not a leftover row that happens to read the same.
 */
function sameAdoptedState(loaded, source) {
  if (!loaded || !source) return false;
  if ((loaded.taskDescription || "") !== (source.taskDescription || "")) return false;
  if ((loaded.currentPhase || "idle") !== (source.currentPhase || "idle")) return false;
  if ((loaded.workflowTaskId || "") !== (source.workflowTaskId || "")) return false;
  if (Number(loaded.dodRevision || 0) !== Number(source.dodRevision || 0)) return false;
  return true;
}

/** Semua state sesi lain di proyek ini yang masih punya task berjalan. */
export function findResumableCandidates({ stateFile, now = Date.now(), isAlive = null } = {}) {
  const projectDir = projectDirFromStateFile(stateFile);
  const currentKey = STATE_FILE_PATTERN.exec(path.basename(path.resolve(stateFile)))?.[1] || "";
  const candidates = [];

  let userDirs = [];
  try {
    userDirs = readdirSync(path.join(projectDir, "users"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectDir, "users", entry.name));
  } catch {
    return candidates;
  }

  for (const userDir of userDirs) {
    let files = [];
    try {
      files = readdirSync(userDir).filter((name) => STATE_FILE_PATTERN.test(name));
    } catch {
      continue;
    }

    for (const name of files) {
      const key = STATE_FILE_PATTERN.exec(name)[1];
      if (key === currentKey) continue;

      const file = path.join(userDir, name);
      const state = readState(file);
      if (!state) continue;

      const phase = typeof state.currentPhase === "string" ? state.currentPhase : "idle";
      const description = typeof state.taskDescription === "string" ? state.taskDescription.trim() : "";
      if (phase === "idle" || description === "") continue;

      const ownerPid = Number(state.owner?.pid);
      const ownerSeenAt = Number(state.owner?.updatedAt);
      const ownerFresh =
        Number.isFinite(ownerSeenAt) && now - ownerSeenAt < DEFAULT_LOCK_STALE_MS;
      const ownerAlive = Number.isFinite(ownerPid) && typeof isAlive === "function" ? isAlive(ownerPid) : false;
      const live = ownerAlive && ownerFresh;

      const dod = summarizeDod(
        Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [],
        Number(state.dodRevision) || 0,
      );
      const plan = planProgress(Array.isArray(state.plan) ? state.plan : []);

      candidates.push({
        sessionKey: key,
        file,
        taskDescription: description,
        phase,
        projectDir: state.projectDir || "",
        dod,
        plan,
        ownerPid: Number.isFinite(ownerPid) ? ownerPid : null,
        ownerSeenAt: Number.isFinite(ownerSeenAt) ? ownerSeenAt : null,
        live,
        updatedAt: Number.isFinite(ownerSeenAt) ? new Date(ownerSeenAt).toISOString() : "",
      });
    }
  }

  // Yang bisa diambil lebih dulu: yang tidak sedang dikerjakan.
  return candidates.sort((a, b) => Number(a.live) - Number(b.live) || (b.ownerSeenAt || 0) - (a.ownerSeenAt || 0));
}

function describeCandidate(candidate, index) {
  const when = candidate.updatedAt ? new Date(candidate.updatedAt).toLocaleString() : "waktu tidak tercatat";
  const status = candidate.live
    ? `⛔ sedang dikerjakan PID ${candidate.ownerPid} (tidak bisa diambil)`
    : "✅ bisa diambil";

  return (
    ` ${index + 1}. ${candidate.sessionKey}\n` +
    `    Task  : "${candidate.taskDescription}"\n` +
    `    Fase  : ${candidate.phase}   DoD: ${candidate.dod.done}/${candidate.dod.total}` +
    (candidate.plan.total > 0 ? `   Rencana: ${candidate.plan.done}/${candidate.plan.total}` : "") + "\n" +
    `    Terakhir: ${when}   ${status}`
  );
}

export async function handleResumeSession(args, workflowState) {
  const adoptKey = typeof args.adopt === "string" ? args.adopt.trim() : "";

  if (workflowState.state.currentPhase !== "idle") {
    return textResponse(
      `⚠️ Sesi ini sedang mengerjakan task: "${workflowState.state.taskDescription}".\n\n` +
        `Selesaikan atau batalkan dulu (complete_task / drop_task) sebelum mengambil alih task lain.\n` +
        `Mengambil alih sekarang akan mengosongkan DoD task yang sedang berjalan.`
    );
  }

  const candidates = findResumableCandidates({
    stateFile: workflowState.stateFile,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    },
  });

  if (!adoptKey) {
    if (candidates.length === 0) {
      return textResponse(
        "Tidak ada state sesi lain yang tertinggal di proyek ini. Tidak ada yang perlu disambung."
      );
    }

    return textResponse(
      `🔌 State sesi lain yang ditemukan di proyek ini:\n\n` +
        candidates.map(describeCandidate).join("\n\n") +
        `\n\nUntuk melanjutkan salah satunya:\n` +
        `  resume_session { "adopt": "<session-key>" }\n\n` +
        `Berkas aslinya TIDAK dihapus — adopsi adalah salinan, dan jejaknya tetap ada untuk diperiksa.`
    );
  }

  const chosen = candidates.find((candidate) => candidate.sessionKey === adoptKey);
  if (!chosen) {
    return textResponse(
      `⚠️ Tidak ada state dengan kunci "${adoptKey}" di proyek ini.\n\n` +
        (candidates.length > 0
          ? `Yang tersedia:\n${candidates.map((c) => `   • ${c.sessionKey}`).join("\n")}`
          : "Tidak ada state sesi lain yang tertinggal.")
    );
  }

  if (chosen.live) {
    return textResponse(
      `⚠️ Dibatalkan: state itu sedang dikerjakan PID ${chosen.ownerPid}, yang masih menulis.\n\n` +
        `Menyalinnya akan membuat dua sesi mengerjakan task yang sama, dan yang satu akan menimpa ` +
        `yang lain. Tutup sesi itu lebih dulu; bila sudah tertutup, penjaga ini berhenti menghalangi ` +
        `setelah 10 menit tanpa tulisan state.`
    );
  }

  const source = readState(chosen.file);
  if (!source) {
    return textResponse("⚠️ Berkas state itu tidak bisa dibaca. Tidak ada yang diubah.");
  }

  // A handover is not a generic left-behind session: it is a fenced transfer.
  // When the source carries a handover sidecar, only the session that won the
  // exclusive claim may adopt it, and only after the controller proved the old
  // owner exited. Without this the single-winner claim would not fence adoption
  // at all: a loser could copy the task whenever it got the worktree mutex.
  const handoverSidecar = `${chosen.file}.restart-handshake.json`;
  const hasHandover = existsSync(handoverSidecar);
  if (hasHandover) {
    const handshake = readHandshake(handoverSidecar);
    if (handshake.status !== "ok") {
      return textResponse(
        `⚠️ Adoption refused: the handover record at "${handoverSidecar}" is not readable. Nothing was changed.`
      );
    }
    const state = handshake.record?.state;
    if (state !== "PROCESS_EXIT_VERIFIED" && state !== "RELAUNCHED") {
      return textResponse(
        `⚠️ Adoption refused: the handover is at ${state}; a successor may only adopt after PROCESS_EXIT_VERIFIED. ` +
          `Nothing was changed.`
      );
    }
    // The sidecar must describe the very state being copied. A misplaced or
    // stale sidecar plus its claim must not authorize a different session's task.
    const h = handshake.record?.handover || {};
    if (h.sessionKey !== chosen.sessionKey) {
      return textResponse(
        `⚠️ Adoption refused: the handover names session "${h.sessionKey}", not "${chosen.sessionKey}". ` +
          `Nothing was changed.`
      );
    }
    if (h.stateFile && path.resolve(String(h.stateFile)) !== path.resolve(String(chosen.file))) {
      return textResponse(
        `⚠️ Adoption refused: the handover points at a different state file than the one being copied. ` +
          `Nothing was changed.`
      );
    }
    if (h.todoId && source.zettly?.todoId && Number(h.todoId) !== Number(source.zettly.todoId)) {
      return textResponse(
        `⚠️ Adoption refused: the handover names Todo #${h.todoId}, but the source state is Todo ` +
          `#${source.zettly.todoId}. Nothing was changed.`
      );
    }
    // The source JSON must still be the task the owner checkpointed. A changed
    // or stale file with the same session key must not supply a different task.
    const snap = h.snapshot;
    if (snap) {
      const mismatch = snap.fingerprint
        ? stateFingerprint(source) !== snap.fingerprint
        : (snap.taskDescription || "") !== (source.taskDescription || "");
      if (mismatch) {
        return textResponse(
          `⚠️ Adoption refused: the source state no longer matches the task snapshot the owner ` +
            `checkpointed. Nothing was changed.`
        );
      }
    }
    const claim = readClaim(handoverSidecar);
    if (!claim) {
      return textResponse(
        `⚠️ Adoption refused: this handover has no claim. Claim it first with restart_handshake { action: "claim" }. ` +
          `Nothing was changed.`
      );
    }
    if (claim.adoptedAt) {
      return textResponse(
        `⚠️ Adoption refused: the handover was already adopted by ${claim.sessionKey} at ${claim.adoptedAt}. ` +
          `Adopting it again would discard that successor's progress.`
      );
    }
    const self = String(workflowState.sessionId || "");
    if (!self || claim.sessionKey !== self) {
      return textResponse(
        `⚠️ Adoption refused: the claim belongs to ${claim.sessionKey}, not this session. ` +
          `Only the winning successor may adopt the handover. Nothing was changed.`
      );
    }
    // The claim must belong to this process, not merely to a reused session
    // string. A fresh process that happens to reuse the id must go through
    // recovery, which proves the previous claimant is gone.
    if (Number(claim.pid) !== process.pid) {
      return textResponse(
        `⚠️ Adoption refused: the claim was made by PID ${claim.pid}, not this process (${process.pid}). ` +
          `A different process must recover the claim first. Nothing was changed.`
      );
    }
    if (claim.startedAt || claim.executable) {
      let info = null;
      try {
        info = createLocalAdapters().processInfo(process.pid);
      } catch {
        info = null;
      }
      const startMismatch = claim.startedAt && info?.startedAt && String(claim.startedAt) !== String(info.startedAt);
      const exeMismatch = claim.executable && info?.executable && String(claim.executable) !== String(info.executable);
      if (startMismatch || exeMismatch) {
        return textResponse(
          `⚠️ Adoption refused: the claim's recorded process identity does not match this process. ` +
            `Nothing was changed.`
        );
      }
    }
  }

  // Salin ke berkas sesi ini, pertahankan isi apa adanya.
  const target = workflowState.stateFile;
  mkdirSync(path.dirname(target), { recursive: true });

  // Adoption makes this session the owner of the task, so it must also become
  // the owner of the worktree. The startup placeholder capability is released
  // when the real session is established, and only `start_task` re-acquires it;
  // a successor never calls `start_task`, so without this it adopts a task it
  // can never checkpoint. Acquire BEFORE the state write: if another live owner
  // still holds the worktree, the adoption is refused and nothing changes.
  const adoptProjectDir = source.projectDir || workflowState.state.projectDir || "";
  // The mutex must be for the worktree this session actually operates in. The
  // state file itself lives in a separate state bucket, so the comparison is
  // between the source's recorded worktree and this session's runtime project,
  // not between the state file and the worktree.
  let sessionProjectDir = workflowState.state.projectDir || "";
  if (!sessionProjectDir) {
    try {
      sessionProjectDir = resolveProjectDir({
        env: process.env,
        candidates: [process.cwd(), process.env.INIT_CWD],
      }).dir;
    } catch {
      sessionProjectDir = "";
    }
  }
  if (adoptProjectDir && sessionProjectDir) {
    const sourceRoot = resolveCanonicalWorktreeRoot(adoptProjectDir);
    const sessionRoot = resolveCanonicalWorktreeRoot(sessionProjectDir);
    if (!sourceRoot.ok || !sessionRoot.ok || sourceRoot.canonicalKey !== sessionRoot.canonicalKey) {
      return textResponse(
        `⚠️ Adoption refused: the source state belongs to "${adoptProjectDir}", which is not this session's ` +
          `worktree ("${sessionProjectDir}"). A task cannot be adopted across projects. Nothing was changed.`
      );
    }
  }
  // The capability owner key is the resolved state-file path: `_capabilityMatchesSession`
  // accepts it directly, and unlike the derived session key it cannot change when
  // the state is reloaded.
  const adoptOwnerKey = path.resolve(String(target));
  const adoptMutex = await acquireWorktreeMutex({
    projectDir: adoptProjectDir,
    ownerKey: adoptOwnerKey,
  });
  if (!adoptMutex.ok) {
    return textResponse(
      `⚠️ Adoption refused: the worktree mutex for "${adoptProjectDir}" could not be acquired ` +
        `(${adoptMutex.reason || "MUTEX_ERROR"}).\n\n` +
        `Another live session may still own this working tree. Nothing was changed; the source ` +
        `state is untouched.`
    );
  }

  const resumed = {
    ...source,
    owner: undefined,
    history: Array.isArray(workflowState.state.history) ? workflowState.state.history : [],
    resumedFrom: { sessionKey: chosen.sessionKey, file: chosen.file, at: new Date().toISOString() },
  };
  delete resumed.owner;

  // Keep the previous target and the previous stored state so a failed adoption
  // can be rolled back instead of leaving the copied task on disk or in SQLite
  // with ownership released.
  let previousTarget = null;
  try {
    previousTarget = readFileSync(target, "utf8");
  } catch {
    previousTarget = null;
  }
  const previousState = workflowState.state ? JSON.parse(JSON.stringify(workflowState.state)) : null;

  const abandon = async (message) => {
    // Restore the target file and the stored row so a later load cannot expose
    // a task that was never durably adopted.
    try {
      if (previousTarget === null) {
        if (existsSync(target)) rmSync(target, { force: true });
      } else {
        writeFileSync(target, previousTarget, "utf8");
      }
    } catch {
      // Best effort; the message still reports the failure.
    }
    try {
      if (previousState && typeof workflowState.restoreStateIntoStore === "function") {
        await workflowState.restoreStateIntoStore(previousState);
      }
    } catch {
      // Best effort; the claim stays unadopted so recovery can reconcile.
    }
    try {
      workflowState.boundKernelCapability = null;
      if (previousState) workflowState.state = previousState;
    } catch {
      // In-memory cleanup is best effort.
    }
    try {
      await releaseWorktreeMutex(adoptMutex.capability);
    } catch {
      // The process still exits eventually; the message is the important part.
    }
    return textResponse(message);
  };

  try {
    writeFileSync(target, JSON.stringify(resumed, null, 2), "utf8");
  } catch (error) {
    return await abandon(
      `⚠️ Adoption did not commit: the state file could not be written (${error?.message || error}). ` +
        `The worktree mutex was released; nothing was adopted.`
    );
  }
  if (typeof workflowState.bindKernelCapability === "function") {
    workflowState.bindKernelCapability(adoptMutex.capability);
  }

  // The reload must actually reflect the adopted task. `load()` prefers an
  // existing SQLite row for this session over the JSON file, so a successor
  // that already had a row would otherwise be told "adopted" while its old
  // state was reloaded. Write the copied state into the store first, then
  // reload and verify the whole task identity, not just its description.
  try {
    await workflowState.adoptJsonIntoStore();
  } catch (error) {
    return await abandon(
      `⚠️ Adoption did not commit: the copied state could not be written to the store ` +
        `(${error?.message || error}). The worktree mutex was released; retry when the store is writable.`
    );
  }
  await workflowState.load({ skipWrites: true });
  if (!sameAdoptedState(workflowState.state, source)) {
    return await abandon(
      `⚠️ Adoption did not commit: the reloaded state does not match the source task ` +
        `("${source.taskDescription || ""}"). The worktree mutex was released; nothing was adopted.`
    );
  }

  // Revalidate the README-first preflight against the current working tree.
  // Documentation edits are reported, not treated as failures; the caller
  // decides whether a change affects the task contract.
  let preflightNote = "";
  const previous = workflowState.state.preflight;
  if (previous && previous.ok) {
    const revalidated = revalidatePreflight(previous, { projectDir: workflowState.state.projectDir });
    if (revalidated.ok) {
      workflowState.state.preflight = revalidated.current;
      if (revalidated.changed) {
        preflightNote =
          `\n\n⚠️ Repository guidance changed since the task started:\n` +
          revalidated.changes.map((change) => `   • ${change}`).join("\n") +
          `\nRe-read the changed files before continuing.`;
      }
    } else {
      preflightNote = `\n\n⚠️ Preflight could not be revalidated: ${revalidated.code}.`;
    }
  } else {
    const fresh = runPreflight({
      projectDir: workflowState.state.projectDir,
      taskId: workflowState.state.workflowTaskId || "",
    });
    if (fresh.ok) {
      workflowState.state.preflight = fresh;
      preflightNote = `\n\nℹ️ Preflight recorded for this resumed task.`;
    }
  }

  // The adoption commit point is the state file plus the verified store reload
  // above. This final save persists the preflight note; the worktree mutex is
  // held, so it should succeed. If it does not, the adoption is not durable and
  // must not be reported as success or marked adopted.
  try {
    const saved = await workflowState.save();
    if (saved && (saved.verified === false || saved.conflict)) {
      return await abandon(
        `⚠️ Adoption is not durable: the final save reported a conflict, so another writer's state ` +
          `was kept. The claim was NOT marked adopted. The worktree mutex was released.`
      );
    }
  } catch (error) {
    return await abandon(
      `⚠️ Adoption is not durable: the state was copied but the final save failed ` +
        `(${error?.message || error}). The claim was NOT marked adopted, so recovery can still ` +
        `reconcile it. The worktree mutex was released.`
    );
  }

  // Finalize the claim only after the adoption is durable, so recovery can never
  // discard this successor's progress. The claim stays as the audit record of
  // who won; only the adopted marker is added.
  let claimNote = "";
  if (hasHandover) {
    const marked = markClaimAdopted(handoverSidecar, { sessionKey: String(workflowState.sessionId || "") });
    if (!marked.ok) {
      claimNote = `\n\nℹ️ The claim could not be marked adopted (${marked.code}); recovery may need manual review.`;
    }
  }

  const dod = summarizeDod(workflowState.state.definitionOfDone, workflowState.state.dodRevision);
  const outstanding = dod.open > 0 ? `\n\nDoD yang belum terpenuhi:\n${renderOutstanding(workflowState.state.definitionOfDone, workflowState.state.dodRevision)}` : "";

  return textResponse(
    `✅ Adopted the state of session "${chosen.sessionKey}".\n\n` +
      `Task      : ${workflowState.state.taskDescription}\n` +
      `Phase     : ${workflowState.state.currentPhase}\n` +
      `DoD       : ${dod.done}/${dod.total} proven, ${dod.open} open\n` +
      `Plan      : ${planProgress(workflowState.state.plan).done}/${planProgress(workflowState.state.plan).total}\n` +
      `Source file kept at: ${chosen.file}\n` +
      outstanding +
      preflightNote +
      claimNote +
      `\n\nContinue with 'continue_workflow' or 'get_workflow_status'.`
  );
}
