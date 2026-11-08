/**
 * Which tasks are already claimed right now?
 *
 * WHY
 * ---
 * `start_task` refuses when another live process holds the same project, but the
 * agent only learns that after choosing a task, and the message names a PID
 * without saying what that process is working on. An agent with several open
 * tasks therefore cannot choose a free one on the first attempt.
 *
 * This module turns the claim data the monitor already receives into a short,
 * readable list. It is intentionally pure: no network, no database, no state.
 */

/**
 * How long a claim stays believable.
 *
 * The monitor treats a session as "possibly stuck" after 15 minutes without a
 * report, so a claim older than that is no longer a reliable signal that
 * someone is actively working. Keep this aligned with the monitor's LIVE window.
 */
export const CLAIM_STALE_MS = 15 * 60 * 1000;

const PHASES_WITHOUT_WORK = new Set(['idle', 'closed', 'done', 'cancelled', 'archived']);

function ageMs(updatedAt, now) {
  const parsed = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

/**
 * Decide whether one claim should be reported to a caller.
 *
 * @returns {{claimed: boolean, reason: 'held'|'own'|'stale'|'idle'|'unknown', ageMs: number|null}}
 */
export function summarizeClaim({claim, now = Date.now(), ownSessionKey = ''} = {}) {
  const c = claim || {};
  const age = ageMs(c.updatedAt, now);

  if (!c.sessionKey) return {claimed: false, reason: 'unknown', ageMs: age};
  if (PHASES_WITHOUT_WORK.has(String(c.phase || ''))) return {claimed: false, reason: 'idle', ageMs: age};
  if (ownSessionKey && c.sessionKey === ownSessionKey) return {claimed: false, reason: 'own', ageMs: age};
  if (age === null || age > CLAIM_STALE_MS) return {claimed: false, reason: 'stale', ageMs: age};

  return {claimed: true, reason: 'held', ageMs: age};
}

/** "3m", "1j 12m", "45d" - the same shape the monitor uses. */
export function formatClaimAge(ms) {
  if (!Number.isFinite(ms)) return '?';
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}j ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}d`;
}

/**
 * One line per live claim, excluding the caller's own claim and stale ones.
 *
 * @returns {string[]}
 */
export function describeClaims({claims = [], now = Date.now(), ownSessionKey = ''} = {}) {
  const lines = [];

  for (const claim of Array.isArray(claims) ? claims : []) {
    const result = summarizeClaim({claim, now, ownSessionKey});
    if (!result.claimed) continue;

    const parts = [claim.projectName || '(tanpa proyek)', claim.agent || 'unknown'];
    if (claim.machine) parts.push(claim.machine);
    if (claim.task) parts.push(`"${String(claim.task).slice(0, 80)}"`);
    parts.push(`${formatClaimAge(result.ageMs)} lalu`);

    lines.push(parts.join(' · '));
  }

  return lines;
}

/**
 * The block `start_task` prepends to its success message, or '' when free.
 */
export function claimReportBlock({claims = [], now = Date.now(), ownSessionKey = ''} = {}) {
  const lines = describeClaims({claims, now, ownSessionKey});
  if (!lines.length) return '';

  return [
    '🔒 Task yang sedang dikerjakan sesi lain saat ini:',
    ...lines.map((line) => `  • ${line}`),
    'Pilih task yang belum tercantum di atas supaya dua sesi tidak berebut pekerjaan yang sama.',
  ].join('\n');
}
