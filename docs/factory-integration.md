# Factory integration

Three MCP tools connect this server to the Factory board at
`https://factory.programinglive.com`:

| Tool | Direction | Endpoint |
|---|---|---|
| `list_factory_tasks` | read | `GET /api/factory` |
| `create_factory_task` | write | `POST /api/factory` (`action: create_task`) |
| `update_factory_task` | write | `POST /api/factory` (`action: update_task`) |
| `claim_factory_task` | write | `POST /api/work` (`action: start`) |
| `sync_task_status` | write | `POST /api/work` (`action: finish`) or `POST /api/factory` (`action: move_task`) |

The goal is simple: **the agent should never have to guess what Factory can do.**
Every limit of the real API is encoded in the client, so a wrong request fails
with an explanation instead of a silent no-op.

---

## 1. Configuration

The tools stay inert (they print setup instructions) until one usable credential
set exists.

```bash
FACTORY_URL=https://factory.programinglive.com
FACTORY_EMAIL=mahatma.mahardhika@programinglive.com
FACTORY_PASSWORD=<password>
```

`FACTORY_EMAIL` + `FACTORY_PASSWORD` are exchanged for a PocketBase
`activity_users` token, which Factory accepts as a Bearer header. The token is
cached in memory for 10 minutes, so the exchange happens once per process, not
once per call.

If you already have a token, skip the password:

```bash
FACTORY_TOKEN=<activity_users token>
```

### Full variable list

| Variable | Default | Meaning |
|---|---|---|
| `FACTORY_URL` | — (required) | Factory base URL. Trailing slashes are stripped. |
| `FACTORY_TOKEN` | — | PocketBase `activity_users` token. Wins over email/password. |
| `FACTORY_EMAIL` | — | Account used to obtain a token. |
| `FACTORY_PASSWORD` | — | Password for that account. |
| `FACTORY_PB_URL` | `https://pocketbase.programinglive.com` | Where the token is obtained. |
| `FACTORY_MACHINE_ID` | hostname | Device name shown on the board (max 100 chars). |
| `FACTORY_DEVICE_ID` | - | Fixed device UUID. Wins over the shared device file. |
| `FACTORY_DEVICE_FILE` | `~/.config/programinglive-factory/device.json` | Device identity shared with the Factory CLI. |
| `FACTORY_AGENT` | `dev-workflow-mcp` | Agent label stored on the session (max 40 chars). |

### Why `activity_users` and not a superuser

Factory's auth layer (`lib/auth.ts`) reads either the `factory_session` cookie or
an `Authorization: Bearer <token>` header, then validates that token against
PocketBase `activity_users`. A superuser token is not accepted there and would
grant far more access than needed anyway.

### Where to put the variables

They must exist in the environment of the **MCP server process**, not just your
shell. In OpenCode that means the `environment` block of the server entry:

```jsonc
{
  "mcp": {
    "servers": {
      "dev-workflow": {
        "type": "local",
        "command": ["node", "C:\\path\\to\\dev-workflow-mcp-server\\index.js"],
        "environment": {
          "FACTORY_URL": "https://factory.programinglive.com",
          "FACTORY_PB_URL": "https://pocketbase.programinglive.com",
          "FACTORY_EMAIL": "you@example.com",
          "FACTORY_PASSWORD": "…",
          "FACTORY_MACHINE_ID": "HELLOWORLD",
          "FACTORY_AGENT": "opencode-deepseek"
        }
      }
    }
  }
}
```

`{env:NAME}` substitution is supported, but it reads OpenCode's **own**
environment. If the variables are not exported before OpenCode starts, the MCP
server sees empty strings and reports "not configured". Writing the values
directly is simpler; the file lives in the user profile and is not a repository.

Verify:

```bash
opencode mcp list
# ✓ dev-workflow  connected
```

Then ask the server for the board:

```bash
node index.js call list_factory_tasks
```

---

## 2. What Factory can and cannot do

Factory is **not** a generic CRUD store. The write surface is three actions:

```
POST /api/factory   { action: "create_task" | "move_task" | "update_task" }
POST /api/work      { action: "start" | "heartbeat" | "finish" }
```

There is no endpoint that sets an arbitrary status. That single fact drives the
whole design:

| Status | How it is reached | Who may do it |
|---|---|---|
| `backlog` | `move_task` | agent |
| `queued` | `move_task` | agent |
| `cancelled` | `move_task` | agent |
| `running` | a **work session** is started | agent, via `claim_factory_task` |
| `review` | work session finished with `outcome=review` | agent |
| `blocked` | work session finished with `outcome=blocked` | agent |
| `paused` | work session finished with `outcome=paused` | agent |
| `done` | `move_task`, only from `review` | agent, via `sync_task_status` |

`sync_task_status` enforces this:

- `review` → **refused when the task already has a `work.review` or `task.done`
  event**. Factory reads a second review as an approval, so repeating it moves
  the task to `done` without a human decision. This happened on 29 October 2026:
  a session left in `review` while the board still showed `backlog` meant the
  next `review` report approved the task. The client now stops before the
  network call and tells the caller to ask the owner for `done` (or to send the
  task back to `backlog`).
- `running` → rejected: *"Use claim_factory_task… Factory records that as a work session, not a status edit."*
- `done` → sent as `move_task`. Factory accepts it **only** when the task is
  currently in `review`, and requires a reason; otherwise it answers `409`.
  Factory also answers `409` while the task's `definitionOfDone` is empty, so a
  task created before that field existed must be completed with
  `update_factory_task` first.
- `done` / `cancelled` → the reason **must** travel in the `move_task` body
  (trimmed, max 500). Factory rejects a close without it:
  *"Alasan wajib diisi (minimal 3 karakter)…"*. Before this was fixed the reason
  was dropped, so closing any task from MCP failed with HTTP 400 — and because
  the handler returns text instead of throwing, the failure looked like success
  to a caller that did not read the response.
- `backlog` **from `review`** → rejected with `409`. `move_task` only moves
  tasks that are currently `backlog` or `queued`. To send a reviewed task back
  to the backlog, finish a work session with `outcome=paused` (see the note
  below); that is the only supported path.
- unknown value → rejected, listing the accepted statuses
- `review` / `blocked` / `paused` **without an active session** → rejected with
  "no active work session. Use claim_factory_task first"

Note that `paused` is a work *outcome*; Factory stores the task as `backlog`
afterwards. The client therefore resolves outcomes before validating against the
task-status list.

---

## 3. Typical flow

```
list_factory_tasks                      → pick a task, note its id and its DoD
claim_factory_task { recordId, step }    → task becomes running, session opens
… work …
sync_task_status { recordId, status: "review", reason: "…" }
                                         → session closes, task waits for approval
```

Before claiming, read the task's `definitionOfDone`: that checklist is what the
owner will check when approving. If a task has none (it was created before the
field existed), fill it with `update_factory_task` — otherwise `done` is
rejected with `409` no matter how much evidence the summary carries.

### Filling a missing definition of done

```
update_factory_task {
  recordId: "<uuid>",
  definitionOfDone: "- [ ] build lulus\n- [ ] halaman login terverifikasi"
}
```

The tool reads the task's current version first and sends it as
`expectedUpdatedAt`. If another session changed the task in between, Factory
answers `409` and the tool tells the agent to reload instead of overwriting that
change.

### Taking over a task held by another device

The server decides whether a claim is a takeover; the client does not refuse on
its own. A task whose active session belongs to **another device** can be taken
over by supplying a reason:

```
claim_factory_task { recordId, step, takeoverReason: "Pemilik lama offline 3 hari, saya lanjutkan." }
```

The reason must be 3-500 characters and is required for **every** takeover,
whether or not the previous holder is still reporting. Factory closes the
previous session as `taken_over` with the reason stored on it, opens a new
session on your device, and records a `work.taken_over` event naming both
devices. The previous holder is locked out of that task immediately.

Without a reason, the server answers `409` and the client turns it into an
actionable message:

```json
{
  "error": "Task sedang dikerjakan di perangkat lain. Ambil alih dengan menyertakan alasan takeover.",
  "takeoverRequired": true,
  "holder": { "deviceName": "MMCH", "agent": "Codex", "lastSeenAt": "2026-10-27T06:00:31.249Z" }
}
```

A claim of a task whose active session belongs to the **same device** is not a
takeover: the server resumes that session idempotently and no reason is needed.

This matters on a shared board: two agents claiming the same task would
otherwise fight over one session row, and a takeover always leaves a written
record of why the work changed hands.

### Device identity

Factory keys work sessions by device UUID. The MCP server and the Factory CLI
must agree on that UUID, otherwise one machine shows up as two devices and a
task held by the other tool looks like another machine's work.

Both therefore read the same file: `FACTORY_DEVICE_FILE`, defaulting to
`~/.config/programinglive-factory/device.json` (the file the CLI writes, mode
0600). Whichever tool runs first creates it; the other adopts that id.
`FACTORY_DEVICE_ID` still overrides everything, and `deviceIdFor(name)` is the
last-resort fallback when the file cannot be read or created.

A session is resumed silently only when **both** the device id and the agent
match. Sharing a machine is not the same as being the same worker: the CLI
reports as `Codex` and the MCP server as its configured `FACTORY_AGENT`, so
taking a task from the other tool on the same machine still needs a takeover
reason.

### Keeping a session alive

Factory marks a session stale after 120 seconds without a report. A claimed
task that never reports looks abandoned on the board even while the work
continues, which is why the MCP server used to show every task it took as
"no news" almost immediately.

`session-keeper.js` reports a heartbeat every 60 seconds for the session this
process opened. It is deliberately bounded:

- it reports only for a session this process claimed, never someone else's;
- it stops the moment the session is finished through `sync_task_status`;
- it stops on `409`/`404`, which mean the session ended or another device took
  it over — retrying would fight the new holder;
- the timer is `unref()`ed, so it never keeps the process alive. A session
  that outlives the process is exactly what "stale" is for.

A heartbeat that outlived the claim would lie in the opposite direction,
showing "active" for work nobody is doing.

---

## 4. API limits encoded in the client

| Field | Limit | Handling |
|---|---|---|
| `step` | 240 chars | truncated |
| `summary` | 2000 chars | truncated |
| device `name` | 100 chars | truncated |
| device `agent` | 40 chars | truncated |
| summary minimum | 3 chars | rejected locally |
| list `limit` | 1–200 | clamped, default 50 |

Truncation happens before the request, so a long summary cannot cause a 400.

---

## 5. Mapping a Factory task

`GET /api/factory` returns `{ projects, tasks, events }`. The client resolves
`projectId` to a readable name using the same payload:

```json
{
  "id": "77ff10a3-42fb-45dd-84c6-5438abcdc26a",
  "taskKey": "77ff10a3",
  "title": "…",
  "status": "running",
  "priority": "high",
  "projectName": "programinglive/dev-workflow-mcp-server",
  "definitionOfDone": "- [ ] build lulus\n- [ ] halaman login terverifikasi",
  "work": {
    "id": "f14531c5-…",
    "state": "active",
    "step": "Analisa API Factory asli",
    "deviceName": "HELLOWORLD"
  }
}
```

`definitionOfDone` adalah checklist kondisi yang harus benar sebelum task boleh
ditutup. `formatTaskList` menampilkannya sebagai baris `DoD:`, dan
`claim_factory_task` menyertakannya di keluaran klaim supaya agen membacanya
sebelum bekerja. `acceptance` tetap terpisah: itu syarat diterima plus blok
` ```run ` yang dieksekusi worker.

Ordering is status first (`running` → `queued` → `backlog` → `review` →
`blocked` → `done` → `cancelled`), then priority (`high` → `normal` → `low`).
Terminal statuses are hidden by default so the queue shows live work.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Factory is not configured on this machine.` | env vars missing in the MCP process | put them in `mcp.servers.<name>.environment` |
| `Factory login failed (HTTP 401)` | wrong password, or a superuser instead of `activity_users` | fix credentials |
| `Factory request failed (HTTP 403)` | `Origin` mismatch on a browser-only route | use the Bearer path, which this client does |
| `no active work session` | asking for `review` without claiming | `claim_factory_task` first |
| `takeoverRequired: true` | another device (or an earlier run) still holds the task | call `claim_factory_task` again with a `takeoverReason` of 3-500 characters |
| `Alasan takeover minimal 3 karakter.` | the reason is too short to explain the handover | write a longer reason |
| `Alasan takeover maksimal 500 karakter.` | the reason is too long | shorten it |
| task stays `backlog` after a claim | the claim went to a different Factory account | check `FACTORY_EMAIL` |

### Legacy note

The previous version of this integration wrote to the PocketBase
`activity_tasks` collection (`open` / `in_progress` / `blocked` / `done`). That
collection still exists but is **empty (0 records)** — the writes never reached
the board, which is why tasks created through the MCP were invisible in Factory.
`FACTORY_PB_IDENTITY` / `FACTORY_PB_PASSWORD` are gone; use
`FACTORY_URL` + `FACTORY_EMAIL` / `FACTORY_PASSWORD` instead.

---

## 7. Tests

```bash
npm test
```

`tests/factory-client.test.js` covers configuration, device identity, the status
routing table, payload shaping and the HTTP layer against a fake `fetch`.
`tests/factory-handlers.test.js` covers the three handlers, including the
"refuse before calling the network" cases.

The suite is the contract: if Factory gains a new status or endpoint, add a test
first, then change the client.
