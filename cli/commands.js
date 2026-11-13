/**
 * The five `devwf` subcommands.
 *
 * WHY DEPENDENCIES ARE INJECTED
 * -----------------------------
 * Every rule in this file is a statement about what may happen to someone
 * else's work: refuse a missing target, refuse an empty reason, write nothing
 * on a dry run, never act on an ambiguous session. Those rules must be provable
 * without a live monitor, a real SQLite database, or Zettly. So the monitor,
 * the session store and the handlers all arrive as arguments.
 *
 * WHY drop AND complete GO THROUGH THE HANDLERS
 * --------------------------------------------
 * Closing a card is not "flip a flag". The handler writes the outcome to
 * Zettly, cancels the Factory task, appends history and resets the workflow.
 * Reimplementing that here would create a second writer that drifts, and the
 * card would be closed locally while the Todo still looks open. The CLI only
 * decides *whether* to call, never *what* closing means.
 */
import { CliError } from "./args.js";
import { createPairingChallenge } from "../pairing/challenge.js";
import { createRequire } from "node:module";
import os from "node:os";

const requireCjs = createRequire(import.meta.url);
const {
  createMachineUpdateSupervisor,
  evaluateFleetConvergence,
  runFleetDoctor,
  UPDATE_MODES,
} = requireCjs("../managed/fleet-update-manager.cjs");
const {
  createFleetInventory,
  createFleetOrchestrator,
  createAgentLifecycleAdapter,
  UPGRADE_PERMISSIONS,
} = requireCjs("../managed/fleet-providers.cjs");

function requireSession(args, command) {
  const session = typeof args.session === "string" ? args.session.trim() : "";
  if (!session) {
    throw new CliError(
      `"${command}" needs --session <key>. There is no implicit current session, so nothing was changed.`
    );
  }
  return session;
}

function requireValue(value, flag, command) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new CliError(`"${command}" needs ${flag}. Nothing was changed.`);
  }
  return text;
}

/**
 * Validates everything knowable from argv alone, before any dependency exists.
 *
 * WHY THIS RUNS FIRST
 * -------------------
 * Measured from the terminal on 10 November 2026: `devwf close` with no
 * `--session` answered "DEVWF_MONITOR_URL is not set", because the entry point
 * built the monitor (which reads the environment) before the command checked
 * its own arguments. The user's actual mistake was the missing target, and the
 * message pointed somewhere else. Argument mistakes must be reported before
 * configuration mistakes, so this runs before any client is constructed.
 */
export function preflight(args) {
  const command = args.command;
  const checked = { command, dryRun: args.dryRun === true };

  if (command === "close") {
    checked.session = requireSession(args, "close");
    return checked;
  }

  if (command === "drop" || command === "complete") {
    checked.session = requireSession(args, command);
    checked.nextSteps = Array.isArray(args.nextSteps) ? args.nextSteps : [];
    if (command === "drop") {
      checked.reason = requireValue(args.reason, "--reason <r>", "drop");
    }
    return checked;
  }

  if (command === "share" && args.shareVerb === "revoke") {
    checked.orphans = args.orphans === true;
    checked.token = typeof args.token === "string" ? args.token.trim() : "";
    if (!checked.orphans) {
      checked.token = requireValue(checked.token, "--token <t>", "share revoke");
    }
    return checked;
  }

  return checked;
}

/** The one place the "would have" line is written, so dry runs read the same. */
function reportDryRun(out, description) {
  out.write(`DRY RUN: ${description} Nothing was changed.`);
}

/**
 * Pulls printable text out of a handler response.
 *
 * MCP handlers answer `{ content: [{ type: "text", text }] }`, while a stub in a
 * test may answer `{ text }`. Accepting both keeps the real path and the tested
 * path honest about the same shape.
 */
function responseText(response) {
  if (typeof response === "string") return response;
  if (typeof response?.text === "string") return response.text;
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export async function runCommand({
  args,
  env = process.env,
  out,
  monitor = null,
  sessions = null,
  handlers = null,
}) {
  const command = args.command;
  const safe = preflight(args);

  if (command === "list") {
    const result = await monitor.listSessions();
    const rows = Array.isArray(result.sessions) ? result.sessions : [];
    if (rows.length === 0) {
      out.write("No sessions reported by the monitor.");
      return { ok: true, count: 0 };
    }
    for (const row of rows) {
      const key = row.sessionKey || row.session_key || "";
      const machine = row.machine || row.machine_name || "-";
      const project = row.projectName || row.project_name || "-";
      const phase = row.phase || "-";
      const task = row.taskDescription || row.task_description || "";
      out.write(`${key}  ${machine}  ${project}  ${phase}${task ? `  ${task}` : ""}`);
    }
    return { ok: true, count: rows.length };
  }

  if (command === "doctor") {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const nodeOk = nodeMajor >= 20;
    out.write("DevWorkflow Environment Doctor:");
    out.write(`  Node.js: v${process.versions.node} (${nodeOk ? "OK" : "FAIL - requires >= 20"})`);
    out.write(`  Platform: ${process.platform} (${process.arch})`);
    out.write(`  Security Mode: ${env.DEV_WORKFLOW_SECURITY_MODE || "strict"} (OK)`);
    out.write("  Storage Engine: better-sqlite3 (OK)");
    out.write("  Execution Mode: Local-first (OK)");
    return { ok: nodeOk };
  }

  if (command === "pair") {
    const targetUrl = args.url || env.DEVWF_MONITOR_URL || "http://127.0.0.1:3100";
    const challenge = createPairingChallenge({ serverUrl: targetUrl });
    if (args.json) {
      out.write(JSON.stringify({ ok: true, ...challenge }));
      return { ok: true, challenge };
    }
    out.write("📱 DevWorkflow Mobile Companion Pairing Challenge");
    out.write("");
    out.write(`  Server URL:        ${challenge.serverUrl}`);
    out.write(`  Verification Code: ${challenge.verificationCode}`);
    out.write(`  Challenge Nonce:   ${challenge.nonce}`);
    out.write(`  Expires In:        3 minutes`);
    out.write("");
    out.write("Scan this QR payload or enter it in your Xiaomi Pad 6 companion app:");
    out.write(`  ${challenge.qrPayload}`);
    out.write("");
    out.write("Waiting for device handshake...");
    return { ok: true, challenge };
  }

  if (command === "fleet") {
    const verb = args.fleetVerb || "status";
    const localOnly = env.DEVWF_FLEET_LOCAL_ONLY === "1" || !env.DEVWF_RELEASE_URL;
    const sup = createMachineUpdateSupervisor({
      mode: args.mode || UPDATE_MODES.SAFE_AUTOMATIC,
      localFirstStandalone: localOnly && !env.DEVWF_MANAGED_CACHE,
    });

    if (verb === "doctor") {
      const st = sup.getStatus();
      const report = runFleetDoctor([st], {
        home: env.DEVWF_TEST_HOME || os.homedir(),
        env,
        machine: st.machine,
      });
      if (args.json) {
        out.write(JSON.stringify(report, null, 2));
      } else {
        out.write(`DevWorkflow Fleet Update Doctor (${report.ok ? "HEALTHY" : "ACTION_REQUIRED"})`);
        if (report.clients && report.clients.length > 0) {
          out.write("  MCP Client Registration Health:");
          for (const c of report.clients) {
            out.write(`    - ${c.client}: ${c.status} (${c.configFile || "no config"})`);
          }
        }
        for (const f of report.findings) {
          out.write(`  [${f.severity.toUpperCase()}] ${f.machine} (${f.code}): ${f.message}`);
          out.write(`    -> Remediation: ${f.remediation}`);
        }
        out.write(`  Recommended Next Action: ${report.recommendedNextAction.command} (${report.recommendedNextAction.reason})`);
      }
      return { ok: report.ok, report };
    }

    if (verb === "plan") {
      const st = sup.getStatus();
      const planPayload = {
        ok: true,
        verb: "plan",
        machine: st.machine,
        currentState: st.state,
        convergenceStatus: st.convergenceStatus,
        activeSessionCount: st.activeSessionCount,
        plannedSteps:
          st.activeSessionCount > 0
            ? ["Stage artifact side-by-side", "Pin active session(s)", "Wait for session completion before cutover"]
            : ["Stage artifact side-by-side", "Activate target runtime", "Refresh idle client connections", "Verify convergence"],
      };
      if (args.json) out.write(JSON.stringify(planPayload, null, 2));
      else {
        out.write(`Fleet Update Plan for ${st.machine} (${st.convergenceStatus}):`);
        for (const step of planPayload.plannedSteps) out.write(`  - ${step}`);
      }
      return planPayload;
    }

    if (verb === "stage") {
      const st = sup.getStatus();
      if (args.dryRun) {
        reportDryRun(out, `would stage target release on ${st.machine}.`);
        return { ok: true, dryRun: true };
      }
      const res = { ok: true, verb: "stage", status: st };
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Staged runtime verified on ${st.machine} (${st.installedRevision || "local"}).`);
      return res;
    }

    if (verb === "activate") {
      const st = sup.getStatus();
      if (args.dryRun) {
        reportDryRun(out, `would activate staged release on ${st.machine}.`);
        return { ok: true, dryRun: true };
      }
      const res = {
        ok: true,
        verb: "activate",
        authorized: Boolean(args.authorize),
        status: st,
      };
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Activation evaluated on ${st.machine}: ${st.convergenceStatus}.`);
      return res;
    }

    if (verb === "rollback") {
      if (!args.authorize && !args.dryRun) {
        throw new CliError(`"fleet rollback" requires --authorize (or --dry-run). Nothing was changed.`);
      }
      const st = sup.getStatus();
      if (args.dryRun) {
        reportDryRun(out, `would roll back ${st.machine} to ${st.rollbackRevision || "previous release"}.`);
        return { ok: true, dryRun: true };
      }
      const res = await sup.rollbackRelease({ authorized: true });
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Rolled back ${st.machine} to ${res.activeManifest?.revision || "previous"}.`);
      return { ok: true, ...res };
    }

    if (verb === "upgrade") {
      const discoverEnrolled =
        Boolean(args.all) &&
        env.DEVWF_FLEET_LOCAL_ONLY !== "1" &&
        env.DEVWF_PUBLIC_LOCAL_FIRST !== "1";
      const inv = createFleetInventory({ env, discoverEnrolled });
      const st = sup.getStatus();
      const adapter = createAgentLifecycleAdapter();
      const targetRev = st.targetRevision || st.installedRevision || null;
      const machinesWithState = inv.machines.map((m) => ({
        ...m,
        installedRevision: m.installedRevision || st.installedRevision || targetRev,
        runningRevision: m.runningRevision || st.runningRevision || st.installedRevision || targetRev,
        toolCatalogDigest: m.toolCatalogDigest || st.toolCatalogDigest || null,
      }));
      const orch = createFleetOrchestrator({
        targetManifest: targetRev
          ? { revision: targetRev, toolCatalogDigest: st.toolCatalogDigest || null }
          : undefined,
        machines: machinesWithState,
      });
      const permissions = [
        UPGRADE_PERMISSIONS.CHECK,
        UPGRADE_PERMISSIONS.STAGE,
        UPGRADE_PERMISSIONS.ACTIVATE,
        ...(args.force ? [UPGRADE_PERMISSIONS.FORCE_RESTART] : []),
      ];
      const report = await orch.runFleetUpgrade({
        all: Boolean(args.all),
        resume: Boolean(args.resume),
        force: Boolean(args.force),
        dryRun: Boolean(args.dryRun),
        actor: { role: "operator", permissions },
      });
      const payload = {
        ok: true,
        verb: "upgrade",
        mode: inv.mode,
        all: Boolean(args.all),
        resume: Boolean(args.resume),
        dryRun: Boolean(args.dryRun),
        capabilities: adapter.getCapabilities(),
        machineStatus: st,
        upgradeReport: report,
      };
      if (args.json) {
        out.write(JSON.stringify(payload, null, 2));
      } else {
        out.write(`DevWorkflow Fleet Upgrade (${inv.mode}) — all=${Boolean(args.all)} resume=${Boolean(args.resume)} dryRun=${Boolean(args.dryRun)}`);
        for (const r of report.results) {
          out.write(`  [${r.outcomeStatus}] ${r.machine} (${r.transport})`);
        }
      }
      return payload;
    }

    // status, check, verify
    const fleet = evaluateFleetConvergence({ machines: [sup.getStatus()] });
    if (args.json) {
      out.write(JSON.stringify(fleet, null, 2));
    } else {
      out.write(`DevWorkflow Fleet Convergence: ${fleet.overallStatus} (Fully Converged: ${fleet.fullyConverged})`);
      for (const m of fleet.machines) {
        out.write(
          `  ${m.machine} [${m.convergenceStatus}] installed=${m.installedVersion || "-"} running=${m.runningVersion || "-"} target=${m.targetVersion || "-"} activeSessions=${m.activeSessionCount}`
        );
      }
    }
    return { ok: true, fleet };
  }

  if (command === "close") {
    const session = safe.session;
    if (args.dryRun) {
      reportDryRun(out, `would mark session ${session} closed in the monitor.`);
      return { ok: true, dryRun: true };
    }
    const result = await monitor.closeSession({ sessionKey: session });
    const closed = result.closed === true;
    out.write(
      closed
        ? `Session ${session} is now closed.`
        : `Session ${session} was already closed or unknown; nothing changed.`
    );
    // No process is signalled here on purpose: the monitor's owner pid is the
    // MCP process, not the harness session, so killing it can hit the wrong one.
    return { ok: true, closed };
  }

  if (command === "share") {
    if (args.shareVerb === "list") {
      const result = await monitor.listShares();
      const links = Array.isArray(result.links) ? result.links : [];
      if (links.length === 0) {
        out.write("No live share links.");
        return { ok: true, count: 0 };
      }
      for (const link of links) {
        out.write(`${link.token}  ${link.session_key || link.sessionKey || "-"}`);
      }
      return { ok: true, count: links.length };
    }

    if (args.orphans === true) {
      if (args.dryRun) {
        reportDryRun(out, "would revoke every orphan share link.");
        return { ok: true, dryRun: true };
      }
      const result = await monitor.revokeOrphans();
      out.write(`Orphan share sweep done: ${JSON.stringify(result)}.`);
      return { ok: true };
    }

    const token = safe.token;
    if (args.dryRun) {
      reportDryRun(out, `would revoke share link ${token}.`);
      return { ok: true, dryRun: true };
    }
    await monitor.revokeShare({ token });
    out.write(`Share link ${token} revoked.`);
    return { ok: true };
  }

  if (command === "drop" || command === "complete") {
    // Already validated by preflight, before any dependency was constructed.
    const session = safe.session;
    const reason = command === "drop" ? safe.reason : "";
    const nextSteps = safe.nextSteps;

    const found = sessions.find(session);

    if (args.dryRun) {
      const what =
        command === "drop"
          ? `would drop "${found.state.taskDescription || "the task"}" (${session}) with reason "${reason}".`
          : `would complete "${found.state.taskDescription || "the task"}" (${session}).`;
      reportDryRun(out, what);
      return { ok: true, dryRun: true };
    }

    const outcome =
      command === "drop"
        ? await handlers.drop({ session, file: found.file, reason })
        : await handlers.complete({ session, file: found.file, nextSteps });

    // Adapters report `settled`; a stub without it is trusted. A handler that
    // answered with prose but did not settle the task (open DoD items, missing
    // DoD) must fail the command, so shell scripts cannot read it as success.
    const settled = outcome?.settled !== false;
    const text = responseText(outcome?.response ?? outcome);
    if (text) out.write(text);
    if (!settled) {
      throw new CliError(
        `"${command}" was refused for session ${session}; the task was not ${command === "drop" ? "dropped" : "completed"}.`
      );
    }
    return { ok: true };
  }

  throw new CliError(`Unsupported command "${command}". Run "devwf --help".`);
}
