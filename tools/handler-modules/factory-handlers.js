import { textResponse } from "./shared.js";
import { parseFactoryChecklist } from "./dod.js";
import { startKeeping, stopKeeping } from "../../session-keeper.js";
import {assignWorkflowIdentity} from '../../zettly-workflow.js';
import {
  readFactoryConfig,
  listTasks,
  findTask,
  claimTask,
  updateTaskStatus,
  updateTaskDetails,
  createTask,
  listProjects,
  formatTaskList,
  formatProjectList,
  planStatusTransition,
} from "../../factory-client.js";

/**
 * Factory tools stay inert unless a Factory URL and credentials are set.
 * That keeps the MCP server usable on machines without Factory access.
 */
function requireConfig() {
  const config = readFactoryConfig();
  if (!config) {
    return {
      config: null,
      response: textResponse(
        [
          "Factory is not configured on this machine.",
          "",
          "Set these environment variables where the MCP server is launched:",
          "  FACTORY_URL=https://factory.programinglive.com",
          "  FACTORY_TOKEN=<PocketBase activity_users token>",
          "",
          "Or let the client log in for you:",
          "  FACTORY_EMAIL=<activity_users email>",
          "  FACTORY_PASSWORD=<password>",
          "",
          "Optional:",
          "  FACTORY_PB_URL=<PocketBase base URL, default https://pocketbase.programinglive.com>",
          "  FACTORY_MACHINE_ID=<name shown on the device row>",
          "  FACTORY_DEVICE_ID=<fixed device UUID>",
        ].join("\n"),
      ),
    };
  }
  return { config, response: null };
}

export async function handleListFactoryTasks(args = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const statuses = Array.isArray(args.statuses) && args.statuses.length ? args.statuses : undefined;
  const project = typeof args.project === "string" && args.project.trim() ? args.project.trim() : null;
  const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 50;

  try {
    const tasks = await listTasks(config, { statuses, project, limit });
    return textResponse(formatTaskList(tasks));
  } catch (error) {
    return textResponse(`Could not read the Factory queue: ${error.message}`);
  }
}

/**
 * Formats how long ago a work session was last seen.
 *
 * Returns an empty string when the timestamp is missing or unparsable, so the
 * caller can leave that part of the message out instead of printing garbage.
 */
function formatLastSeen(value) {
  if (!value) return "";
  const seen = Date.parse(value);
  if (Number.isNaN(seen)) return "";
  const minutes = Math.floor((Date.now() - seen) / 60000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

/**
 * Builds the message shown when Factory refuses a claim because another device
 * still holds the task.
 *
 * The refusal is actionable: it names the holder and shows the exact call to
 * make, so the agent does not have to guess which parameter is missing.
 */
function takeoverRequiredMessage(title, holder = {}) {
  const seen = formatLastSeen(holder.lastSeenAt);
  const name = String(holder.deviceName || "").trim();
  const agent = String(holder.agent || "").trim();
  const holderText = name && agent ? `${name} (${agent})` : name || agent;
  return [
    `"${title}" is being worked on by another device.`,
    holderText ? `Holder: ${holderText}${seen ? `, last seen ${seen}` : ""}.` : "",
    "",
    "To take it over, call claim_factory_task again with a takeoverReason of 3-500 characters:",
    '  claim_factory_task { "recordId": "<id>", "step": "<step>", "takeoverReason": "<why you are taking over>" }',
    "",
    "The reason is stored on the board so the next person knows why the work changed hands.",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

export async function handleClaimFactoryTask(args = {}, { workflowState } = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  if(args.zettlyTodoId!==undefined&&(!Number.isSafeInteger(args.zettlyTodoId)||args.zettlyTodoId<1))return textResponse('Provide a positive zettlyTodoId to reuse an existing canonical Todo.');
  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to claim (see list_factory_tasks).");
  }

  const takeoverReason = typeof args.takeoverReason === "string" ? args.takeoverReason.trim() : "";
  // Judul diambil di luar try supaya pesan penolakan tetap menyebut task yang
  // sebenarnya, bukan teks umum.
  let taskTitle = "Task ini";

  try {
    const task = await findTask(config, recordId);
    if (!task) {
      return textResponse(`No task with id "${recordId}" is visible to this account.`);
    }
    taskTitle = task.title;

    const step = typeof args.step === "string" && args.step.trim() ? args.step.trim() : "Working on the task";
    const session = await claimTask(config, { recordId, step, takeoverReason });
    if (!session) throw new Error("Factory accepted the claim but returned no work session.");

    // Tanpa ini sesi jadi "tidak ada kabar" dalam 120 detik padahal sedang
    // dikerjakan, dan papan terlihat penuh task mati.
    startKeeping(config, session, step);

    // Arsipkan task lokal yang sedang berjalan, jangan hapus diam-diam.
    //
    // 31 Oktober 2026 claim_factory_task dipanggil di tengah task lain yang baru
    // sampai tahap rilis. `reset()` tanpa archive membuat task itu lenyap: tidak
    // ada entri history, tidak ada peringatan, tidak disebut di jawaban.
    // `start_task` sudah mengarsipkan sejak awal; claim tidak.
    let archivedTask = null;
    let continuingTask = false;
    // Checklist papan diimpor sebagai RENCANA, bukan bukti: setiap item masuk
    // sebagai `open` walau di papan sudah dicentang. Centang di papan berarti
    // seseorang pernah menyatakannya, bukan bahwa kode di mesin ini terbukti.
    const importedDod = parseFactoryChecklist(task.definitionOfDone);
    if (workflowState) {
      continuingTask=workflowState.state.zettly?.externalLinks?.factory?.id===recordId&&Boolean(workflowState.state.taskDescription);
      if(!continuingTask){
      const archived = workflowState.reset({
        archive: true,
        reason: "Diganti claim_factory_task sebelum task selesai",
      });
      archivedTask = archived?.archivedTask || null;
      const now = new Date().toISOString();
      workflowState.state.currentPhase = "coding";
      workflowState.state.taskDescription = `[${task.taskKey || task.id}] ${task.title}`;
      workflowState.state.taskType = "other";
      workflowState.state.definitionOfDone = importedDod.items.map((text, index) => ({
        id: `dod-${index + 1}`,
        text,
        status: "open",
        evidence: "",
        waivedReason: "",
        revision: 0,
        updatedAt: now,
      }));
      workflowState.state.dodSource = importedDod.items.length > 0 ? "factory" : "";
      workflowState.state.dodFactoryTaskId = importedDod.items.length > 0 ? recordId : "";
      workflowState.state.dodRevision = 0;
      assignWorkflowIdentity(workflowState.state,null,{zettlyTodoId:args.zettlyTodoId,source:{system:'factory',id:recordId}});
      }else if(args.zettlyTodoId){if(workflowState.state.zettly.todoId!==args.zettlyTodoId)workflowState.state.zettlyContext=null;workflowState.state.zettly.todoId=args.zettlyTodoId;}
      workflowState.state.zettly.externalLinks={...workflowState.state.zettly.externalLinks,factory:{id:recordId,taskKey:task.taskKey||''}};
      await workflowState.save();
    }

    return textResponse(
      [
        `Claimed [${task.taskKey || task.id}] ${task.title}`,
        archivedTask
          ? `⚠️ Task lokal yang belum selesai diarsipkan ke history: "${archivedTask}". ` +
            `Pekerjaannya tidak dihapus, tetapi tidak lagi aktif di sesi ini.`
          : "",
        session.tookOver && session.previousHolder
          ? `Took over from ${session.previousHolder.deviceName} (${session.previousHolder.agent}). The reason is recorded on the board.`
          : "",
        `Factory status is now running (work session ${session.id}).`,
        task.projectName ? `Project: ${task.projectName}` : "",
        continuingTask ? 'Existing canonical workflow, progress and Zettly link were retained.' : importedDod.items.length > 0
          ? `Imported ${importedDod.items.length} definition-of-done item(s) from the board, all OPEN:\n` +
            importedDod.items.map((text, index) => `   dod-${index + 1}: ${text}`).join("\n") +
            (importedDod.truncated
              ? "\n   (Some board items were shortened or dropped: at most 20 items of 300 characters are kept.)"
              : "") +
            "\n   Prove each one locally with 'mark_dod_item' { id, evidence }, or waive it with a reason."
          : "This board task has no definition of done. Add one with 'set_definition_of_done' { items: [...] } - " +
            "a task cannot be committed or closed without it.",
        "",
        continuingTask ? 'Local workflow continued for this task.' : 'Local workflow started for this task.',
        "Use 'sync_task_status' with review, blocked or paused to close the session, or done to approve the task once it is in review.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    // Factory menolak take over tanpa alasan. Balas dengan arahan yang bisa
    // dijalankan, bukan dengan pesan error mentah.
    if (error?.body?.takeoverRequired) {
      return textResponse(takeoverRequiredMessage(taskTitle, error.body.holder));
    }
    return textResponse(`Could not claim the task: ${error.message}`);
  }
}

export async function handleSyncTaskStatus(args = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  const status = typeof args.status === "string" ? args.status.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason : null;
  const nextAction = typeof args.nextAction === "string" ? args.nextAction : null;

  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to update.");
  }
  if (!status) {
    return textResponse("Provide 'status'. Factory accepts: backlog, queued, review, blocked, paused, cancelled, done.");
  }
  if (status === "blocked" && !reason) {
    return textResponse("Marking a task blocked requires a 'reason' so the next person knows what is missing.");
  }

  // Validate locally so the agent gets an actionable message instead of a
  // transport error from Factory.
  try {
    planStatusTransition(status);
  } catch (error) {
    return textResponse(error.message);
  }

  try {
    const result = await updateTaskStatus(config, { recordId, status, reason, nextAction });
    // Sesi ditutup, jadi berhenti melaporkan: heartbeat setelah ini akan
    // ditolak server dan hanya mengaburkan keadaan papan.
    stopKeeping();

    // Checklist dibaca lagi setelah status berubah: DoD bisa saja dilengkapi
    // sejak claim, dan agen perlu kriteria terbaru saat melaporkan selesai.
    // Kegagalan bacaan tambahan ini tidak boleh membuat laporan status yang
    // sudah berhasil terlihat gagal.
    let definitionOfDone = "";
    try {
      const task = await findTask(config, recordId);
      definitionOfDone = String(task?.definitionOfDone || "").trim();
    } catch {
      definitionOfDone = "";
    }

    return textResponse(
      [
        `Updated ${recordId} to ${result.status}.`,
        result.session?.summary ? `Summary: ${result.session.summary}` : "",
        definitionOfDone ? `Definition of done:\n${definitionOfDone}` : "",
        result.status === "review" ? "Waiting for human approval in Factory." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return textResponse(`Could not update the task: ${error.message}`);
  }
}

/**
 * Lists projects, because create_task needs a real projectId (UUID) and the
 * agent cannot invent one.
 */
export async function handleListFactoryProjects() {
  const { config, response } = requireConfig();
  if (!config) return response;

  try {
    const projects = await listProjects(config);
    return textResponse(formatProjectList(projects));
  } catch (error) {
    return textResponse(`Could not read the Factory projects: ${error.message}`);
  }
}

/**
 * Creates a task on the board through the official write path.
 *
 * Defaults to `backlog`. Factory starts a worker run for `queued` tasks, so
 * recording work must not enqueue execution by accident.
 */
export async function handleCreateFactoryTask(args = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const title = typeof args.title === "string" ? args.title.trim() : "";
  const acceptance = typeof args.acceptance === "string" ? args.acceptance.trim() : "";
  const definitionOfDone = typeof args.definitionOfDone === "string" ? args.definitionOfDone.trim() : "";

  if (!title) {
    return textResponse("Provide 'title' for the task (3-140 characters).");
  }
  if (!acceptance) {
    return textResponse(
      [
        "Provide 'acceptance': what must be true for this task to count as done.",
        "Factory requires it, and it is what the next person checks.",
      ].join("\n"),
    );
  }
  if (!definitionOfDone) {
    return textResponse(
      [
        "Provide 'definitionOfDone': the checklist that must be true before this task can be marked done.",
        "Use one condition per line, for example:",
        "- [ ] build lulus",
        "- [ ] halaman login terverifikasi",
        "It is stored separately from 'acceptance', which also carries the ```run block for the worker.",
      ].join("\n"),
    );
  }
  if (!args.projectId) {
    return textResponse(
      "Provide 'projectId'. Run 'list_factory_projects' first - Factory needs a real project UUID.",
    );
  }

  try {
    const created = await createTask(config, {
      projectId: args.projectId,
      title,
      description: args.description,
      acceptance,
      definitionOfDone,
      priority: args.priority,
      status: args.status,
    });

    return textResponse(
      [
        `Created task ${created.id ? `[${String(created.id).slice(0, 8)}] ` : ""}${title}`,
        `Status: ${created.status}${created.status === "backlog" ? " (no worker run started)" : ""}`,
        created.runId ? `Worker run queued: ${created.runId}` : "",
        "",
        created.status === "backlog"
          ? "Recorded in the backlog. Use claim_factory_task when someone starts working on it."
          : "Move it out of the queue if execution was not intended.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return textResponse(`Could not create the task: ${error.message}`);
  }
}

/**
 * Edits an existing task, mainly to fill the definition of done of a task that
 * was created before Factory required it.
 *
 * Local validation runs first so an empty request never reaches the network.
 */
export async function handleUpdateFactoryTask(args = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to update (see list_factory_tasks).");
  }

  const hasField = ["title", "description", "acceptance", "definitionOfDone"].some(
    (field) => typeof args[field] === "string",
  );
  if (!hasField) {
    return textResponse(
      [
        "Provide at least one field to update: title, description, acceptance or definitionOfDone.",
        "To fill a missing definition of done, pass definitionOfDone as a checklist, one condition per line.",
      ].join("\n"),
    );
  }

  try {
    const result = await updateTaskDetails(config, {
      recordId,
      title: args.title,
      description: args.description,
      acceptance: args.acceptance,
      definitionOfDone: args.definitionOfDone,
    });

    return textResponse(
      [
        `Updated ${recordId}.`,
        result.updatedAt ? `Task version is now ${result.updatedAt}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    // Factory menjawab 409 kalau task berubah sejak dibaca. Menyebut ulang
    // langkah yang harus diambil lebih berguna daripada kode HTTP saja.
    if (error?.status === 409) {
      return textResponse(
        `Could not update the task: ${error.message}\nReload the task with list_factory_tasks and try again with the current version.`,
      );
    }
    return textResponse(`Could not update the task: ${error.message}`);
  }
}
