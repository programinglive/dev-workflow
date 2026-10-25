import { textResponse } from "./shared.js";
import {
  readFactoryConfig,
  listTasks,
  claimTask,
  updateTaskStatus,
  formatTaskList,
  buildStatusPatch,
} from "../../factory-client.js";

/**
 * Factory tools stay inert unless FACTORY_PB_URL, FACTORY_PB_IDENTITY and
 * FACTORY_PB_PASSWORD are set. That keeps the MCP server usable on machines
 * that have no Factory access at all.
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
          "  FACTORY_PB_URL=https://pocketbase.programinglive.com",
          "  FACTORY_PB_IDENTITY=<activity_users email>",
          "  FACTORY_PB_PASSWORD=<password>",
          "  FACTORY_MACHINE_ID=<optional machine name>",
          "",
          "Use an activity_users account, not a PocketBase superuser: the",
          "activity_tasks rules already scope every row to its owner.",
        ].join("\n"),
      ),
    };
  }
  return { config, response: null };
}

export async function handleListFactoryTasks(args) {
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

export async function handleClaimFactoryTask(args, { workflowState }) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to claim (see list_factory_tasks).");
  }

  const task = (await listTasks(config, { statuses: ["open", "in_progress", "blocked"], limit: 200 })).find(
    (item) => item.id === recordId,
  );
  if (!task) {
    return textResponse(`No task with id "${recordId}" is visible to this account.`);
  }

  try {
    const claimed = await claimTask(config, {
      recordId,
      sessionId: null,
    });

    workflowState.reset();
    workflowState.state.currentPhase = "coding";
    workflowState.state.taskDescription = `${claimed.taskKey || claimed.id}: ${claimed.title}`;
    workflowState.state.taskType = "other";
    await workflowState.save();

    return textResponse(
      [
        `Claimed ${claimed.taskKey || claimed.id}: ${claimed.title}`,
        `Status is now ${claimed.status}.`,
        claimed.nextAction ? `Next action: ${claimed.nextAction}` : "",
        "",
        "Local workflow started for this task.",
        "Use 'sync_task_status' when the work is done or blocked.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return textResponse(`Could not claim the task: ${error.message}`);
  }
}

export async function handleSyncTaskStatus(args) {
  const { config, response } = requireConfig();
  if (!config) return response;

  const recordId = typeof args.recordId === "string" ? args.recordId.trim() : "";
  const status = typeof args.status === "string" ? args.status.trim() : "";

  if (!recordId) {
    return textResponse("Provide the 'recordId' of the task to update.");
  }
  if (!status) {
    return textResponse("Provide 'status': one of open, in_progress, blocked, done.");
  }

  // Validate locally before touching the network so the agent gets an
  // actionable message instead of a transport error.
  try {
    buildStatusPatch({
      status,
      reason: typeof args.reason === "string" ? args.reason : null,
      nextAction: typeof args.nextAction === "string" ? args.nextAction : null,
    });
  } catch (error) {
    return textResponse(error.message);
  }

  try {
    const updated = await updateTaskStatus(config, {
      recordId,
      status,
      reason: typeof args.reason === "string" ? args.reason : null,
      nextAction: typeof args.nextAction === "string" ? args.nextAction : null,
    });

    return textResponse(
      [
        `Updated ${updated.taskKey || updated.id} to ${updated.status}.`,
        updated.blockedReason ? `Blocked reason: ${updated.blockedReason}` : "",
        updated.nextAction ? `Next action: ${updated.nextAction}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return textResponse(`Could not update the task: ${error.message}`);
  }
}
