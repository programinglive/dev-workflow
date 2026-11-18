/**
 * Zettly tags for the zettelkasten method.
 *
 * OWNER INSTRUCTION (10 November 2026)
 * ------------------------------------
 * "Every Zettly note, todo and draw must have a tag, because we adopted the
 * zettelkasten method so we have relations between all our knowledge — so when
 * we need something, we immediately know what is connected."
 *
 * SCOPE, MEASURED RATHER THAN ASSUMED
 * -----------------------------------
 * Checked against the Zettly source on 10 November 2026:
 *   - Todo HAS tags: a `todo_tag` pivot, and `POST /api/todos` accepts `tag_ids`.
 *   - JournalEntry has NO tag relation (fillable is user/date/kind/content/
 *     source/todo_id).
 *   - Drawing has NO tag relation (fillable is user/title/document/thumbnail).
 * So this module tags TODOS today. Tagging draws and journal entries needs a
 * schema change in Zettly itself, which is tracked separately rather than faked
 * here: attaching a tag that the database cannot store would be a lie.
 *
 * WHY FOUR AXES
 * -------------
 * A single combined tag ("devwf-monitor-bugfix") can only be walked one way.
 * Four axes mean the same card can be reached from the codebase, the kind of
 * work, the subsystem, or where it came from — which is the point of the method.
 */

/** Keeps a tag inside what the Zettly unique index can hold without surprises. */
const MAX_TAG_LENGTH = 60;
const MAX_AXIS_VALUE = 40;

/** Words that identify a subsystem, checked against the task text. */
const AREA_HINTS = [
  ['monitor', ['monitor', 'dashboard', 'kartu', 'card', 'rekap', 'riwayat']],
  ['cli', ['cli', 'devwf', 'command', 'subcommand']],
  ['checkpoint', ['checkpoint', 'handoff', 'handover', 'checkpoint_task']],
  ['zettly', ['zettly', 'draw', 'todo', 'tag', 'zettelkasten']],
  ['erp', ['erp', 'clinic', 'laravel', 'livewire']],
  ['deploy', ['deploy', 'release', 'pipeline', 'runner', 'ci']],
  ['sentry', ['sentry', 'issue', 'error']],
  ['infra', ['infra', 'server', 'vm', 'nginx', 'database', 'ssh']],
];

/** Turns any text into one safe segment: lowercase, digits, dot, dash. */
function slug(value, limit = MAX_AXIS_VALUE) {
  const cleaned = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, limit).replace(/[-.]+$/g, '');
}

/** The project name as it appears in the code root, not the whole path. */
function projectSlug(projectDir) {
  const parts = String(projectDir || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return slug(parts.length ? parts[parts.length - 1] : '');
}

/** Which subsystem this task touches, inferred from its own words. */
function areaSlug(taskDescription) {
  const text = String(taskDescription || '').toLowerCase();
  let best = '';
  for (const [area, words] of AREA_HINTS) {
    if (words.some((word) => text.includes(word))) {
      best = area;
      break;
    }
  }
  return best;
}

/** Where the task came from, from the provenance the workflow already records. */
function sourceSlug(taskOrigin) {
  const system = slug(taskOrigin && taskOrigin.system ? taskOrigin.system : 'manual', 20);
  if (!system || system === 'unknown') return 'manual';
  return system;
}

/**
 * The tag names for one task.
 *
 * Always returns at least `tipe:` and `sumber:`, so a card is never untagged
 * even when the project directory is unknown.
 */
export function deriveTags({ taskDescription = '', taskType = '', projectDir = '', taskOrigin = null } = {}) {
  const tags = [];

  const project = projectSlug(projectDir);
  if (project) tags.push(`proyek:${project}`);

  const type = slug(taskType, 20) || 'other';
  tags.push(`tipe:${type}`);

  const area = areaSlug(taskDescription);
  if (area) tags.push(`area:${area}`);

  tags.push(`sumber:${sourceSlug(taskOrigin)}`);

  // De-duplicate while keeping the order (project first: it is the strongest
  // relation), and keep the whole list inside the length the API accepts.
  const unique = [];
  for (const tag of tags) {
    const bounded = tag.slice(0, MAX_TAG_LENGTH);
    if (!unique.includes(bounded)) unique.push(bounded);
  }
  return unique.slice(0, 8);
}

/**
 * Reads a tag list out of the shapes Zettly answers with.
 *
 * MEASURED, NOT GUESSED (10 November 2026): `GET /api/v1/tags` answers
 * `{ "tags": [...], "deletedTags": [...] }` at the TOP level, with no `data`
 * wrapper. Reading only `data.tags` returned an empty list against production,
 * which made `ensureTags` try to create tags that already existed — the fastest
 * way to fill the owner's tag list with duplicates. Both shapes are accepted.
 */
function tagList(response) {
  if (!response) return [];
  const source =
    Array.isArray(response) ? response
    : Array.isArray(response.tags) ? response.tags
    : Array.isArray(response.data?.tags) ? response.data.tags
    : Array.isArray(response.data) ? response.data
    : [];
  return source
    .filter((tag) => tag && tag.name)
    .map((tag) => ({ id: Number(tag.id), name: String(tag.name) }))
    .filter((tag) => Number.isSafeInteger(tag.id) && tag.id > 0);
}

/**
 * Resolves tag names to ids, creating the ones that do not exist yet.
 *
 * NEVER THROWS. A tag is an index, not the work: if Zettly refuses the tag call
 * the task must still be created, otherwise the owner loses the task to gain a
 * label. The caller gets the ids it could resolve and decides nothing else.
 */
export async function ensureTags({ client, names = [] } = {}) {
  const wanted = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim()) : [];
  if (!client || wanted.length === 0) return [];

  let existing = [];
  try {
    existing = tagList(await client.request('GET', '/tags'));
  } catch {
    // Cannot read the list: try to create below and let each failure be skipped.
    existing = [];
  }

  const byName = new Map(existing.map((tag) => [tag.name, tag.id]));
  const ids = [];

  /** Re-reads the owner's tags; used after a 409 or a failed list read. */
  async function refresh() {
    try {
      const list = tagList(await client.request('GET', '/tags'));
      for (const tag of list) byName.set(tag.name, tag.id);
      return list;
    } catch {
      return [];
    }
  }

  for (const name of wanted) {
    if (byName.has(name)) {
      ids.push(byName.get(name));
      continue;
    }
    try {
      const response = await client.request('POST', '/tags', { name });
      const created = tagList(response);
      const id = created.length ? created[0].id : Number(response?.data?.tag?.id || response?.tag?.id || 0);
      if (Number.isSafeInteger(id) && id > 0) {
        byName.set(name, id);
        ids.push(id);
      }
    } catch (error) {
      /*
       * 409 means the tag ALREADY EXISTS: the list read above was stale, or the
       * tag was created between the two calls (the backfill command does exactly
       * that). Treating this as a failure silently dropped half the tags on
       * production on 10 November 2026. Re-read and use the existing id.
       */
      if (error && error.status === 409) {
        const list = await refresh();
        const found = list.find((tag) => tag.name === name);
        if (found) ids.push(found.id);
      }
      // Any other failure is skipped: a tag is an index, not the work.
    }
  }

  return ids;
}
