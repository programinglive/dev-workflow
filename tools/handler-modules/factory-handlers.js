import { textResponse } from "./shared.js";
import {
  readFactoryConfig,
  listTasks,
  findTask,
  claimTask,
  updateTaskStatus,
  formatTaskList,
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

export async function handleClaimFactoryTask(args = {}, { workflowState } = {}) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to claim (see list_factory_tasks).");
  }

  try {
    const task = await findTask(config, recordId);
    if (!task) {
      return textResponse(`No task with id "${recordId}" is visible to this account.`);
    }
    if (task.work?.state === "active") {
      return textResponse(
        [
          `"${task.title}" already has an active work session${task.work.deviceName ? ` on ${task.work.deviceName}` : ""}.`,
          "Finish that session before claiming it again.",
        ].join("\n"),
      );
    }

    const step = typeof args.step === "string" && args.step.trim() ? args.step.trim() : "Working on the task";
    const session = await claimTask(config, { recordId, step });
    if (!session) throw new Error("Factory accepted the claim but returned no work session.");

    if (workflowState) {
      workflowState.reset();
      workflowState.state.currentPhase = "coding";
      workflowState.state.taskDescription = `[${task.taskKey || task.id}] ${task.title}`;
      workflowState.state.taskType = "other";
      await workflowState.save();
    }

    return textResponse(
      [
        `Claimed [${task.taskKey || task.id}] ${task.title}`,
        `Factory status is now running (work session ${session.id}).`,
        task.projectName ? `Project: ${task.projectName}` : "",
        "",
        "Local workflow started for this task.",
        "Use 'sync_task_status' with review, blocked or paused when the work is done.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
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
    return textResponse("Provide 'status'. Factory accepts: backlog, queued, review, blocked, paused, cancelled.");
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

    return textResponse(
      [
        `Updated ${recordId} to ${result.status}.`,
        result.session?.summary ? `Summary: ${result.session.summary}` : "",
        result.status === "review" ? "Waiting for human approval in Factory." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return textResponse(`Could not update the task: ${error.message}`);
  }
}
