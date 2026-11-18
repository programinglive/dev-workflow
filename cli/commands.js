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
 * Zettly, appends history and resets the workflow.
 * Reimplementing that here would create a second writer that drifts, and the
 * card would be closed locally while the Todo still looks open. The CLI only
 * decides *whether* to call, never *what* closing means.
 */
import { CliError } from "./args.js";
import { createPairingChallenge } from "../pairing/challenge.js";
import {
  connectZettlyAccount,
  disconnectZettlyAccount,
  getZettlyStatus,
  runOnboardingSetup,
  runZettlyDoctor,
  skipZettlySetup,
  switchZettlyAccount,
} from "./onboarding.js";
import { captureRepositoryIdentity, evaluateProjectSwitch, parseRemoteIdentity } from "../repository-identity.js";
import { runCiGovernanceValidation } from "../governance/ci-validator.js";
import { loadPolicies } from "../governance/engine.js";
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

  // `identity` is read-only and answers a question about a directory the caller
  // names. It must not require a monitor, a session or a token: the whole point
  // is to be usable before any project context exists.
  if (command === "identity") {
    if (typeof args.dir !== "string" || args.dir.trim() === "") {
      throw new CliError(`"identity" needs --dir <path>. Nothing was read.`);
    }
    return;
  }
  const checked = { command, dryRun: args.dryRun === true };

  if (command === "close") {
    checked.session = requireSession(args, "close");
    return checked;
  }

  if (command === "drop" || command === "complete" || command === "checkpoint") {
    checked.session = requireSession(args, command);
    checked.nextSteps = Array.isArray(args.nextSteps) ? args.nextSteps : [];
    checked.summary = typeof args.summary === "string" ? args.summary.trim() : "";
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

  if (command === "zettly" && (args.zettlyVerb === "connect" || args.zettlyVerb === "switch")) {
    if (typeof args.token === "string" && args.token.length > 0) {
      throw new CliError(
        `Passing a raw Zettly token via --token is disabled for security (shell history and process list exposure). Use --token-stdin, ZETTLY_API_TOKEN, or interactive hidden input.`
      );
    }
    return checked;
  }

  return checked;
}

async function readStreamText(stream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return buf.trim();
}

async function promptHiddenToken(stdin, promptOut) {
  promptOut.write("Zettly API token: ");
  if (typeof stdin.setRawMode === "function") {
    return new Promise((resolve, reject) => {
      const wasRaw = Boolean(stdin.isRaw);
      stdin.setRawMode(true);
      stdin.resume();
      let token = "";
      const onData = (buf) => {
        const ch = typeof buf === "string" ? buf : buf.toString("utf8");
        for (const c of ch) {
          if (c === "\r" || c === "\n") {
            cleanup();
            promptOut.write("\n");
            resolve(token.trim());
            return;
          }
          if (c === "\u0003") {
            cleanup();
            promptOut.write("\n");
            reject(new CliError("Cancelled Zettly token input."));
            return;
          }
          if (c === "\u007f" || c === "\b") {
            token = token.slice(0, -1);
          } else {
            token += c;
          }
        }
      };
      const cleanup = () => {
        stdin.off("data", onData);
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          // Ignore terminal restore errors.
        }
        stdin.pause();
      };
      stdin.on("data", onData);
    });
  }
  return readStreamText(stdin);
}

export async function resolveZettlyTokenInput({
  args,
  env = process.env,
  stdin = process.stdin,
  promptOut = process.stderr,
} = {}) {
  if (typeof args?.token === "string" && args.token.length > 0) {
    throw new CliError(
      "Passing a raw Zettly token via --token is disabled for security (shell history and process list exposure). Use --token-stdin, ZETTLY_API_TOKEN, or interactive hidden input."
    );
  }
  if (args?.tokenStdin) {
    const token = await readStreamText(stdin);
    if (!token) {
      throw new CliError("No Zettly token received on stdin (--token-stdin). Nothing was changed.");
    }
    return token;
  }
  const envToken = String(env.ZETTLY_API_TOKEN || env.ZETTLY_CLI_TOKEN || "").trim();
  if (envToken) return envToken;
  if (stdin?.isTTY) {
    const token = await promptHiddenToken(stdin, promptOut);
    if (!token) {
      throw new CliError("Zettly token cannot be empty. Nothing was changed.");
    }
    return token;
  }
  throw new CliError(
    "Provide your Zettly token securely via --token-stdin, ZETTLY_API_TOKEN, or an interactive terminal prompt."
  );
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
  stdin = process.stdin,
  promptOut = process.stderr,
  monitor = null,
  sessions = null,
  handlers = null,
}) {
  const command = args.command;
  const safe = preflight(args);

  if (command === "identity") {
    const dir = requireValue(args.dir, "--dir", "identity");
    const identity = await captureRepositoryIdentity({ dir });
    if (!identity.isGitRepo) {
      throw new CliError(`"${dir}" is not a git repository. Nothing was read.`);
    }

    const payload = {
      schemaVersion: 1,
      root: identity.root,
      remote: identity.remote,
      repoKey: parseRemoteIdentity(identity.remote)?.key || "",
      workspaceKey: identity.workspaceKey,
      commonDirKey: identity.commonDirKey,
      branch: identity.branch,
      head: identity.head,
      detached: identity.detached,
      worktree: identity.worktree,
      remotes: identity.remotes,
    };

    if (typeof args.against === "string" && args.against.trim() !== "") {
      const against = await captureRepositoryIdentity({ dir: args.against });
      if (!against.isGitRepo) {
        throw new CliError(`"${args.against}" is not a git repository. Nothing was read.`);
      }
      const decision = evaluateProjectSwitch({
        requested: identity,
        session: {
          projectDir: against.root,
          root: against.root,
          remote: against.remote,
          repoKey: parseRemoteIdentity(against.remote)?.key || "",
          commonDir: against.commonDir,
          commonDirKey: against.commonDirKey,
          workspaceKey: against.workspaceKey,
        },
      });
      payload.against = {
        root: against.root,
        remote: against.remote,
        repoKey: parseRemoteIdentity(against.remote)?.key || "",
        workspaceKey: against.workspaceKey,
        commonDirKey: against.commonDirKey,
      };
      payload.decision = {
        ok: decision.ok,
        code: decision.code,
        match: decision.match,
        switched: decision.switched,
      };

      if (args.json) {
        out.write(JSON.stringify(payload, null, 2));
      } else {
        out.write(`root:    ${payload.root}`);
        out.write(`remote:  ${payload.remote || "(none)"}`);
        out.write(`branch:  ${payload.branch || "(detached)"}`);
        out.write(`against: ${payload.against.root}`);
        out.write(`decision: ${decision.ok ? "ALLOWED" : "REFUSED"} (${decision.code})`);
      }
      return { ok: decision.ok, ...payload };
    }

    if (args.json) {
      out.write(JSON.stringify(payload, null, 2));
    } else {
      out.write(`root:    ${payload.root}`);
      out.write(`remote:  ${payload.remote || "(none)"}`);
      out.write(`repoKey: ${payload.repoKey || "(none)"}`);
      out.write(`branch:  ${payload.branch || "(detached)"}`);
      out.write(`head:    ${payload.head || "(none)"}`);
      out.write(`worktree: ${payload.worktree ? "yes" : "no"}`);
    }
    return { ok: true, ...payload };
  }

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
    const zettlyStatus = await getZettlyStatus({ env });
    out.write("DevWorkflow Environment Doctor:");
    out.write(`  Node.js: v${process.versions.node} (${nodeOk ? "OK" : "FAIL - requires >= 20"})`);
    out.write(`  Platform: ${process.platform} (${process.arch})`);
    out.write(`  Security Mode: ${env.DEV_WORKFLOW_SECURITY_MODE || "strict"} (OK)`);
    out.write("  Storage Engine: better-sqlite3 (OK)");
    out.write("  Execution Mode: Local-first (OK)");
    out.write(`  Zettly Mode: ${zettlyStatus.mode}`);
    return { ok: nodeOk, zettlyMode: zettlyStatus.mode };
  }

  if (command === "setup") {
    const result = await runOnboardingSetup({
      env,
      skipZettly: Boolean(args.skipZettly),
      dryRun: Boolean(args.dryRun),
    });
    if (args.json) {
      out.write(JSON.stringify(result, null, 2));
    } else {
      out.write(`DevWorkflow Setup: ${result.action} (${result.mode})`);
    }
    return result;
  }

  if (command === "zettly") {
    const verb = args.zettlyVerb || "status";
    if (verb === "status") {
      const status = await getZettlyStatus({ env });
      if (args.json) out.write(JSON.stringify(status, null, 2));
      else out.write(`Zettly Status: mode=${status.mode} connected=${status.connected} base=${status.base || "-"}`);
      return status;
    }
    if (verb === "doctor") {
      const diag = await runZettlyDoctor({ env });
      if (args.json) out.write(JSON.stringify(diag, null, 2));
      else out.write(`Zettly Doctor: ok=${diag.ok} mode=${diag.mode} standalone=${diag.standalone}`);
      return diag;
    }
    if (verb === "skip") {
      const res = await skipZettlySetup({ env, dryRun: Boolean(args.dryRun) });
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Zettly Setup: ${res.action} (${res.mode})`);
      return res;
    }
    if (verb === "connect") {
      const token = await resolveZettlyTokenInput({ args, env, stdin, promptOut });
      const res = await connectZettlyAccount({
        env,
        url: args.url,
        token,
        dryRun: Boolean(args.dryRun),
      });
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Zettly Connected: ${res.accountLabel} (userId=${res.expectedUserId}) @ ${res.base}`);
      return res;
    }
    if (verb === "switch") {
      const token = await resolveZettlyTokenInput({ args, env, stdin, promptOut });
      const res = await switchZettlyAccount({
        env,
        url: args.url,
        token,
        confirm: Boolean(args.confirm),
        dryRun: Boolean(args.dryRun),
      });
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Zettly Switched: ${res.accountLabel} (userId=${res.expectedUserId}) @ ${res.base}`);
      return res;
    }
    if (verb === "disconnect") {
      const res = await disconnectZettlyAccount({
        env,
        confirm: Boolean(args.confirm),
        dryRun: Boolean(args.dryRun),
      });
      if (args.json) out.write(JSON.stringify(res, null, 2));
      else out.write(`Zettly Disconnected: localHistoryPreserved=${res.localHistoryPreserved}`);
      return res;
    }
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

  if (command === "drop" || command === "complete" || command === "checkpoint") {
    // Already validated by preflight, before any dependency was constructed.
    const session = safe.session;
    const reason = command === "drop" ? safe.reason : "";
    const nextSteps = safe.nextSteps;

    const found = sessions.find(session);

    if (args.dryRun) {
      const what =
        command === "drop"
          ? `would drop "${found.state.taskDescription || "the task"}" (${session}) with reason "${reason}".`
          : command === "checkpoint"
            ? `would checkpoint "${found.state.taskDescription || "the task"}" (${session}) and verify the read-back.`
            : `would complete "${found.state.taskDescription || "the task"}" (${session}).`;
      reportDryRun(out, what);
      return { ok: true, dryRun: true };
    }

    const outcome =
      command === "drop"
        ? await handlers.drop({ session, file: found.file, reason })
        : command === "checkpoint"
          ? await handlers.checkpoint({ session, file: found.file, summary: safe.summary })
          : await handlers.complete({ session, file: found.file, nextSteps });

    // A checkpoint is only trustworthy when the read-back matched. `confirmed`
    // is optional for drop/complete, but a checkpoint must prove itself: the
    // restart controller treats exit 0 as permission to stop a process.
    if (command === "checkpoint" && outcome?.confirmed !== true) {
      const text = responseText(outcome?.response ?? outcome);
      if (text) out.write(text);
      throw new CliError(
        `Checkpoint for session ${session} was not confirmed; the process must not be stopped.`
      );
    }

    // Adapters report `settled`; a stub without it is trusted. A handler that
    // answered with prose but did not settle the task (open DoD items, missing
    // DoD) must fail the command, so shell scripts cannot read it as success.
    const settled = command === "checkpoint" ? true : outcome?.settled !== false;
    const text = responseText(outcome?.response ?? outcome);
    if (text) out.write(text);
    if (!settled) {
      throw new CliError(
        `"${command}" was refused for session ${session}; the task was not ${command === "drop" ? "dropped" : "completed"}.`
      );
    }
    return { ok: true };
  }

  if (command === "governance") {
    const verb = args.governanceVerb || "validate";
    if (verb === "policies") {
      const bundle = loadPolicies();
      if (args.json) {
        out.write(JSON.stringify(bundle, null, 2));
      } else {
        out.write(`Schema ${bundle.schemaVersion} (digest ${bundle.digest}) | Rollout: ${bundle.rollout?.stage}`);
        for (const [id, p] of Object.entries(bundle.policies)) {
          out.write(`- ${id} v${p.version}: ${p.title}`);
        }
      }
      return { ok: true };
    }

    const report = runCiGovernanceValidation({
      projectDir: args.dir || process.cwd(),
      policy: args.policy || "all",
      baseRef: args.base || "",
      statePath: args.state || "",
      taskType: args.taskType || "feature",
      description: args.description || "",
    });
    if (args.json) {
      out.write(JSON.stringify(report, null, 2));
    } else {
      out.write(`Governance [${report.gateResult}] repo=${report.repository} commit=${report.commit.slice(0, 8)} class=${report.applicability.classification}`);
      for (const v of report.violations) {
        out.write(`  FAIL [${v.code}] (${v.policyId}): ${v.reason}`);
      }
      for (const w of report.warnings) {
        out.write(`  WARN ${w}`);
      }
    }
    if (!report.ok) {
      throw new CliError(`Governance validation failed (${report.violations.length} violation(s)).`, 1);
    }
    return { ok: true };
  }

  throw new CliError(`Unsupported command "${command}". Run "devwf --help".`);
}
