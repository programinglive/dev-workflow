# Factory integration

Three MCP tools connect this server to the Factory board at
`https://factory.programinglive.com`:

| Tool | Direction | Endpoint |
|---|---|---|
| `list_factory_tasks` | read | `GET /api/factory` |
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
| `FACTORY_DEVICE_ID` | derived from the name | Fixed device UUID (max 60 chars, must be a UUID). |
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
| `done` | human approval in the Factory UI | **human only** |

`sync_task_status` enforces this:

- `running` → rejected: *"Use claim_factory_task… Factory records that as a work session, not a status edit."*
- `done` → rejected: *"done is decided by a human in Factory."*
- unknown value → rejected, listing the accepted statuses
- `review` / `blocked` / `paused` **without an active session** → rejected with
  "no active work session. Use claim_factory_task first"

Note that `paused` is a work *outcome*; Factory stores the task as `backlog`
afterwards. The client therefore resolves outcomes before validating against the
task-status list.

---

## 3. Typical flow

```
list_factory_tasks                      → pick a task, note its id
claim_factory_task { recordId, step }    → task becomes running, session opens
… work …
sync_task_status { recordId, status: "review", reason: "…" }
                                         → session closes, task waits for approval
```

Re-claiming a task that already has a live session is refused up front:

```
"<title>" already has an active work session on HELLOWORLD.
Finish that session before claiming it again.
```

This matters on a shared board: two agents claiming the same task would otherwise
fight over one session row.

### Device identity

Factory keys work sessions by device UUID. A random UUID per process would create
a new device row on every run, so `deviceIdFor(name)` derives a stable
UUIDv5-shaped id from `FACTORY_MACHINE_ID` (or the hostname). Same machine →
same row, no state file needed. `FACTORY_DEVICE_ID` overrides it.

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
  "work": {
    "id": "f14531c5-…",
    "state": "active",
    "step": "Analisa API Factory asli",
    "deviceName": "HELLOWORLD"
  }
}
```

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
| `already has an active work session` | another device (or an earlier run) still holds it | finish or pause it first |
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
