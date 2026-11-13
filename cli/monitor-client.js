/**
 * The only place the CLI talks HTTP to the central monitor.
 *
 * WHY A THIN CLIENT RATHER THAN NEW ENDPOINTS
 * -------------------------------------------
 * The monitor already owns "session closed" and "share link revoked": those
 * writes exist as `POST /api/session/close`, `DELETE /api/share?token=` and
 * `POST /api/share?revoke-orphans=1`. Adding CLI-only endpoints would give the
 * same state two writers, and the second one always drifts. So this module is
 * a client for what is already there, and nothing more.
 *
 * WHY THE TOKEN IS NEVER ECHOED
 * -----------------------------
 * Errors are printed to terminals, pasted into issues and captured by CI logs.
 * A refusal therefore reports the status and the server's own error text, never
 * the request headers. Missing credentials are refused HERE, before a request
 * is built, so an unauthenticated write cannot leave the process.
 */
import { CliError } from "./args.js";

const BASE_VAR = "DEVWF_MONITOR_URL";
const TOKEN_VAR = "DEVWF_MONITOR_TOKEN";

function readEnv(env, name) {
  const raw = env?.[name];
  return typeof raw === "string" ? raw.trim() : "";
}

export function createMonitorClient({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = readEnv(env, BASE_VAR);
  if (!baseUrl) {
    throw new CliError(
      `${BASE_VAR} is not set. Point it at the central monitor, e.g. http://127.0.0.1:3100.`
    );
  }
  const token = readEnv(env, TOKEN_VAR);
  if (!token) {
    throw new CliError(
      `${TOKEN_VAR} is not set. Writing is refused rather than attempted unauthenticated.`
    );
  }
  const base = baseUrl.replace(/\/+$/, "");

  async function request(method, route, body) {
    const init = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-devwf-close": "1",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response;
    try {
      response = await fetchImpl(`${base}${route}`, init);
    } catch (error) {
      // Network failure: report the route, never the headers.
      throw new CliError(`Cannot reach the monitor at ${base}: ${String(error?.message || error)}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail =
        (payload && (payload.error || payload.note)) || `HTTP ${response.status}`;
      throw new CliError(`Monitor refused ${method} ${route}: ${response.status} ${detail}`);
    }
    return payload ?? {};
  }

  return {
    closeSession({ sessionKey }) {
      return request("POST", "/api/session/close", { sessionKey });
    },
    revokeShare({ token: shareToken }) {
      return request("DELETE", `/api/share?token=${encodeURIComponent(shareToken)}`);
    },
    revokeOrphans() {
      return request("POST", "/api/share?revoke-orphans=1");
    },
    listShares() {
      return request("GET", "/api/share?all=1");
    },
    listSessions() {
      return request("GET", "/api/sessions");
    },
  };
}
