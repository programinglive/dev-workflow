# Session Reaper — Monitor Backend Contract

**Status:** source prepared; deployment requires authorization.
**Related:** `session-reaper.js`, `reaper-client.js`, `scripts/session-reaper.cjs`.

## Why the backend must change

The monitor already stores `owner_pid` in the `sessions` table
(`session-upsert.cjs`), but `sessions-query.cjs` does not select it, so
`/api/sessions` never returns process ownership. The reaper therefore classifies
every session as `RECOVERY_REQUIRED` (`session has no recorded owner PID`).

The fix is deliberately split:

- **Public `/api/sessions`** stays as it is. It must not expose PID, process
  creation time, executable identity or fencing tokens to a browser.
- **Privileged `/api/reaper/sessions`** returns the ownership evidence to an
  authenticated internal controller only.

## 1. Schema

Add the columns if they do not exist:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_started_at text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_executable text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lease_fencing_token text NOT NULL DEFAULT '';
```

## 2. Upsert

In `session-upsert.cjs`, add the new fields to the `INSERT ... ON CONFLICT`
column list and the `EXCLUDED` update list, and bind:

```js
b.ownerStartedAt ? str(b.ownerStartedAt, 80) : '',
b.ownerExecutable ? str(b.ownerExecutable, 300) : '',
b.leaseOwner ? str(b.leaseOwner, 200) : '',
Number.isInteger(b.leaseGeneration) ? b.leaseGeneration : 0,
b.leaseFencingToken ? str(b.leaseFencingToken, 200) : '',
```

The client already sends `ownerStartedAt` and `ownerExecutable` in the snapshot
(`monitor.js`). The lease fields are optional until the lease owner starts
reporting them.

## 3. Privileged endpoint

Add to `monitor.cjs` (before the public `/api/sessions` handler):

```js
if (url.pathname === '/api/reaper/sessions' && req.method === 'POST') {
  const body = bacaJson(await readBody(req), res);
  if (body === null) return undefined;
  const provided = String(req.headers['x-devwf-reaper-signature'] || '');
  const expected = createHmac('sha256', process.env.DEVWF_REAPER_SECRET || '')
    .update(JSON.stringify(body))
    .digest('hex');
  const ok = provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }
  const rows = await query(`
    SELECT session_key, machine, project_name, phase, state, updated_at,
           owner_pid, owner_started_at, owner_executable,
           lease_owner, lease_generation, lease_fencing_token
      FROM sessions
     WHERE phase NOT IN ('closed','done','cancelled')
     ORDER BY updated_at DESC
     LIMIT 200
  `);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  return res.end(JSON.stringify({ ok: true, sessions: rows.rows }));
}
```

`DEVWF_REAPER_SECRET` is provisioned in the monitor's environment file, never in
the browser bundle. The endpoint returns no secret and no credential.

## 4. Client

`reaper-client.js` signs the request with the same secret and maps the rows to
the reaper's session shape. `scripts/session-reaper.cjs` can then run a real
dry-run instead of reporting `RECOVERY_REQUIRED` for every card.

## 5. Rollout

1. Apply the schema and upsert change; restart the monitor (observation only).
2. Deploy the privileged endpoint; verify a signed request returns rows and an
   unsigned request returns 401.
3. Run `scripts/session-reaper.cjs` in dry-run mode; confirm the states match
   the real processes.
4. Enable orphan archival only after the machine-local controllers are running
   on MMCH, HELLOWORLD and Mac.
5. Enable graceful cleanup only for explicitly disposable sessions.

No step in this document kills a process or releases a lease by itself.
