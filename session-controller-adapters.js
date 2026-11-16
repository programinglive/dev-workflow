/**
 * Operating-system adapters for the machine-local session controller.
 *
 * The controller never receives a bare PID from a remote caller. It receives a
 * session record, re-verifies the process locally, and only then may stop it.
 * These adapters are the only place that touches the OS.
 *
 * `exec` is injected so tests can run without spawning real processes.
 */

import { execFileSync } from "node:child_process";

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pollExit(isAlive, pid, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (!isAlive(pid)) return { ok: true, exited: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, exited: false, reason: "PROCESS_DID_NOT_EXIT" };
}

/** Windows: CIM (wmic fallback) for identity and taskkill for a graceful stop. */
export function createWindowsAdapters({ exec = execFileSync, isAlive = defaultIsAlive } = {}) {
  return {
    isAlive,
    processInfo(pid) {
      // wmic is removed on current Windows 11 builds, so PowerShell CIM is the
      // primary provider and wmic stays only as a fallback for older hosts.
      try {
        const out = String(
          exec(
            "powershell",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
                `if ($p) { $p | Select-Object ProcessId,CreationDate,ExecutablePath | ConvertTo-Json -Compress }`,
            ],
            { encoding: "utf8", windowsHide: true }
          )
        ).trim();
        if (out) {
          const parsed = JSON.parse(out);
          const startedAt = parsed.CreationDate ? String(parsed.CreationDate) : "";
          const executable = parsed.ExecutablePath ? String(parsed.ExecutablePath) : "";
          if (startedAt || executable) return { pid, startedAt, executable };
        }
      } catch {
        // fall through to wmic
      }
      try {
        const out = String(
          exec("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate,ExecutablePath", "/format:list"], {
            encoding: "utf8",
          })
        );
        const startedAt = /CreationDate=(.+)/.exec(out)?.[1]?.trim() || "";
        const executable = /ExecutablePath=(.+)/.exec(out)?.[1]?.trim() || "";
        if (!startedAt && !executable) return null;
        return { pid, startedAt, executable };
      } catch {
        return null;
      }
    },
    requestStop(pid) {
      try {
        exec("taskkill", ["/PID", String(pid)], { encoding: "utf8" });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
      }
    },
    waitForExit(pid, options) {
      return pollExit(isAlive, pid, options);
    },
  };
}

/** macOS: ps for identity and SIGTERM for a graceful stop. */
export function createMacAdapters({ exec = execFileSync, isAlive = defaultIsAlive } = {}) {
  return {
    isAlive,
    processInfo(pid) {
      try {
        const startedAt = String(exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })).trim();
        const executable = String(exec("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" })).trim();
        if (!startedAt && !executable) return null;
        return { pid, startedAt, executable };
      } catch {
        return null;
      }
    },
    requestStop(pid) {
      try {
        process.kill(pid, "SIGTERM");
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
      }
    },
    waitForExit(pid, options) {
      return pollExit(isAlive, pid, options);
    },
  };
}

/** Pick the adapter for the current platform. */
export function createLocalAdapters({ platform = process.platform, ...options } = {}) {
  if (platform === "win32") return createWindowsAdapters(options);
  if (platform === "darwin") return createMacAdapters(options);
  return createMacAdapters(options);
}
