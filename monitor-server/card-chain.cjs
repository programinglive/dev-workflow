'use strict';

/**
 * Zettelkasten card chaining, as pure functions.
 *
 * The dashboard receives a flat list of cards. A link is therefore computed
 * from that list, never from a second query:
 *
 *   - the child knows the id of the card it continued (`parent_task_id`) and
 *     usually its title, carried in the snapshot at start_task time;
 *   - the parent finds its successor by looking for the card whose
 *     `parent_task_id` is its own `task_id` in the same session.
 *
 * Live build boxes are keyed by card, not by session. Keying them by session
 * leaked a running build into the next topic of the same session - the new
 * card looked busy with work it never started.
 */

function text(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Identity of one card inside its session. */
function cardKey(sessionKey, taskId) {
  return `${text(sessionKey)}\u0000${text(taskId)}`;
}

function sameSession(a, b) {
  return text(a && a.session_key) !== '' && text(a && a.session_key) === text(b && b.session_key);
}

/**
 * @param {object} card     a session row with task_id / parent_task_id
 * @param {Array}  siblings other cards known to the caller
 * @returns {{from: string, to: string}}
 */
function chainLabels(card, siblings = []) {
  const rows = Array.isArray(siblings) ? siblings.filter(Boolean) : [];
  const self = card || {};

  let from = text(self.parent_task_title);
  if (!from) {
    const parentId = text(self.parent_task_id);
    if (parentId) {
      const parent = rows.find((row) => sameSession(row, self) && text(row.task_id) === parentId);
      from = parent ? text(parent.task) : '';
    }
  }

  const taskId = text(self.task_id);
  let to = '';
  if (taskId) {
    const child = rows.find(
      (row) => sameSession(row, self) && text(row.parent_task_id) === taskId,
    );
    to = child ? text(child.task) : '';
  }

  return { from, to };
}

/**
 * The live build of a card, or null when the entry belongs to another card.
 *
 * @param {{taskId: string, build: object}|null|undefined} entry
 * @param {object} card
 */
function buildForCard(entry, card) {
  if (!entry || typeof entry !== 'object') return null;
  const owner = text(entry.taskId);
  const mine = text(card && card.task_id);
  if (owner !== mine) return null;
  return entry.build && typeof entry.build === 'object' ? entry.build : null;
}

module.exports = { chainLabels, buildForCard, cardKey };
