import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { textResponse } from "./shared.js";
import { summarize as summarizeDod, renderOutstanding } from "./dod.js";
import { planProgress } from "./plan.js";
import { DEFAULT_LOCK_STALE_MS } from "../../process-lock.js";
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

  // Salin ke berkas sesi ini, pertahankan isi apa adanya.
  const target = workflowState.stateFile;
  mkdirSync(path.dirname(target), { recursive: true });

  const resumed = {
    ...source,
    owner: undefined,
    history: Array.isArray(workflowState.state.history) ? workflowState.state.history : [],
    resumedFrom: { sessionKey: chosen.sessionKey, file: chosen.file, at: new Date().toISOString() },
  };
  delete resumed.owner;

  writeFileSync(target, JSON.stringify(resumed, null, 2), "utf8");
  // `load()` performs a legacy-state migration write, which requires the
  // worktree mutex. A successor does not hold it yet - the mutex is acquired on
  // the next guarded mutation - so that write is refused ("capability_not_held")
  // and the whole adoption appeared to fail after it had already committed.
  // Read-only reload is exactly what the request path uses.
  await workflowState.load({ skipWrites: true });

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

  // The adoption commit point is the state file above: it was written and
  // reloaded, so this session owns the task. This final save only persists the
  // preflight note, and it runs before the successor has acquired the worktree
  // mutex, so it can legitimately be refused. A refusal here must not turn a
  // successful adoption into an error the caller cannot interpret — it is
  // reported as a warning and never as failure.
  let saveNote = "";
  try {
    await workflowState.save();
  } catch (error) {
    saveNote = `\n\nℹ️ Preflight note was not persisted: ${error?.message || error}`;
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
      saveNote +
      `\n\nContinue with 'continue_workflow' or 'get_workflow_status'.`
  );
}
