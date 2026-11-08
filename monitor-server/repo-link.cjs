'use strict';

/**
 * Turn a git remote into a link a person can click.
 *
 * WHY SERVER-SIDE
 * ---------------
 * `repo_path` and `repo_remote` were already stored in the `sessions` table and
 * returned by `/api/sessions`, but nothing rendered them, so the owner still had
 * to hunt for the repository. Converting the remote in the page script would
 * leave the rule untested and duplicated in every client; doing it once here
 * means the dashboard, the share page and any future client agree.
 *
 * WHAT IS ACCEPTED
 * ----------------
 * - `git@github.com:org/repo.git`      (scp-like, what git prints by default)
 * - `ssh://git@gitlab.com/org/repo.git`
 * - `https://github.com/org/repo.git`
 * - `http://`, `git://` (upgraded to https)
 *
 * Anything else yields no link. A remote that is not a web repository must not
 * become an anchor: `javascript:` or `file:` in an href is an injection, not a
 * shortcut. Credentials embedded in the remote are dropped instead of published.
 */

const WEB_SCHEMES = new Set(['http:', 'https:']);

/**
 * @param {unknown} remote raw value from the client's `git remote get-url origin`
 * @returns {{url: string, label: string}|null}
 */
function repoLinkFromRemote(remote) {
  const raw = String(remote == null ? '' : remote).trim();
  if (!raw) return null;

  let url = null;

  // scp-like shorthand: [user@]host:path (no scheme, colon before any slash)
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    url = `https://${scpLike[1]}/${scpLike[2]}`;
  } else {
    try {
      const parsed = new URL(raw);
      if (!WEB_SCHEMES.has(parsed.protocol) && parsed.protocol !== 'git:' && parsed.protocol !== 'ssh:') return null;
      // `ssh:` and `git:` are non-special schemes: the WHATWG URL parser refuses
      // to switch them to `https:` in place, so the web address is rebuilt from
      // the host and path the remote already carries.
      if (!WEB_SCHEMES.has(parsed.protocol)) {
        url = `https://${parsed.hostname}${parsed.pathname}`;
      } else {
        parsed.username = '';
        parsed.password = '';
        url = parsed.toString();
      }
    } catch {
      return null;
    }
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!WEB_SCHEMES.has(parsed.protocol)) return null;
  if (!parsed.hostname.includes('.')) return null;

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');

  const path = parsed.pathname.replace(/^\/+/, '');
  if (!path) return null;

  parsed.protocol = 'https:';
  return { url: parsed.toString(), label: path };
}

/**
 * Attach the derived link to one session row for the dashboard payload.
 *
 * The row is copied, never mutated, so callers can keep using the raw row.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function withRepoLink(row) {
  const link = repoLinkFromRemote(row && row.repo_remote);
  return {
    ...row,
    repo_url: link ? link.url : '',
    repo_label: link ? link.label : '',
  };
}

module.exports = { repoLinkFromRemote, withRepoLink };