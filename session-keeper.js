/**
 * Keeps one Factory work session marked alive while this process holds it.
 *
 * Factory shows a session as stale after 120 seconds without a report. The MCP
 * server claims a task once and then goes quiet, so every task it takes looked
 * abandoned on the board almost immediately - not because the work stopped, but
 * because nothing reported it.
 *
 * The keeper is deliberately bounded: it reports only while this process holds
 * a session it started, and it stops the moment the session ends or is taken
 * over. A heartbeat that outlived the claim would lie in the opposite
 * direction, showing "active" for work nobody is doing.
 */

import { heartbeatWork } from "./factory-client.js";

/** How often to report. Comfortably inside the server's 120 second window. */
const DEFAULT_INTERVAL_MS = 60_000;

let active = null;

async function send(options = {}) {
  if (!active) return null;
  const { config, sessionId, deviceId, step, fetchImpl } = active;
  try {
    return await heartbeatWork(config, { sessionId, deviceId, step }, fetchImpl ?? options.fetchImpl ?? fetch);
  } catch (error) {
    // 409 means the session ended or another device took it over. Retrying
    // would fight the new holder, so stop and let the board show the truth.
    if (error?.status === 409 || error?.status === 404) stopKeeping();
    return null;
  }
}

/**
 * Starts reporting for a session this process just opened.
 *
 * Replaces any previous session, because one process works on one task at a
 * time; two timers would report a session nobody is holding any more.
 */
export function startKeeping(config, session, step, options = {}) {
  stopKeeping();
  const sessionId = session?.id;
  const deviceId = session?.device?.id;
  if (!sessionId || !deviceId) return null;

  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  active = { config, sessionId, deviceId, step: typeof step === "string" ? step : "", fetchImpl: options.fetchImpl, timer: null };

  const timer = setInterval(() => { void send(); }, intervalMs);
  // Never hold the process open just to report; the session outliving the
  // process is exactly what "stale" is for.
  timer.unref?.();
  active.timer = timer;
  return { sessionId, deviceId };
}

/** Stops reporting. Safe to call when nothing is active. */
export function stopKeeping() {
  if (active?.timer) clearInterval(active.timer);
  active = null;
}

/** The session this process is currently reporting, or null. */
export function currentSession() {
  return active ? { sessionId: active.sessionId, deviceId: active.deviceId, step: active.step } : null;
}

/** Sends one report immediately. Used by tests and after a step change. */
export async function beatOnce(options = {}) {
  return send(options);
}
