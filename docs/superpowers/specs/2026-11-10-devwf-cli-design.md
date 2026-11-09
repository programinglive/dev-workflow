# devwf CLI — closing sessions and cards from the terminal

Date: 2026-11-10

## Intent

Closing a stranded session, revoking a share link, or dropping a card can only
be done from the web monitor today. That is fine on the machine that can reach
the dashboard, and useless over SSH, in a script, or when the dashboard is the
thing that is stuck. The owner asked for a CLI for exactly these actions.

## What already exists (and therefore shapes the design)

Measured before designing:

| Action | Existing path |
|---|---|
| Mark a session closed | `POST /api/session/close` (`monitor-server/dashboard.cjs`) with `{ sessionKey }`, write-token guarded |
| Revoke one share link | `DELETE /api/share?token=<t>` |
| Revoke every orphan link | `POST /api/share?revoke-orphans=1` |
| List live links | `GET /api/share?all=1` |
| List sessions | `GET /api/sessions` |
| Drop a task | `handleDropTask` (`tools/handler-modules/commit-handlers.js`) |
| Complete a task | `handleCompleteTask` (same file) |

So the monitor is already the server for the remote actions. The CLI is a thin
client for those, and reuses the existing MCP handlers for the two actions that
must change a session's own state. No new HTTP endpoint is required.

Credentials are already conventional: `DEVWF_MONITOR_URL` and
`DEVWF_MONITOR_TOKEN`, the same pair `monitor.js` uses for
`list_active_sessions`.

## Goals

- Close a session, revoke share links, drop a card, complete a card, all from
  one command.
- Never signal a process. `owner_pid` in the monitor is the **MCP process** pid,
  not the harness session pid, so killing it risks the wrong process. `close`
  only marks the session closed.
- Keep Zettly and history authoritative: `drop` and `complete` go through the
  existing handlers, not through a second write path.

## Non-goals

- Stopping an agent process. Explicitly out of scope; the owner chose "mark
  closed only".
- Replacing the dashboard. Read-only listing comes free, but the web monitor
  stays the primary surface.
- Creating new monitor endpoints.

## Anti-goals (this would make it a failure even if it worked)

- A command that silently targets "the current session". Deleting work must
  always name its target.
- A `drop` that bypasses `handleDropTask` and leaves the Zettly Todo and
  Factory task dangling.
- A `close` that reports success when the monitor answered with a refusal.

## Approaches considered

**A. One `devwf` command with subcommands** (chosen). `list`, `close`,
`share`, `drop`, `complete`. One `bin` entry, one help text, one place to
resolve configuration. `drop` and `complete` load the target session's state and
call the existing handlers.

**B. Four separate scripts** (`bin/close.js`, `bin/revoke.js`, …). Each is
trivial alone, but that is four `bin` entries, four configuration stories, and
four names for the owner to remember. Rejected: more surface, less coherence.

**C. One `devwf` where everything goes through HTTP.** Tempting because it is
the thinnest, but impossible for `drop`/`complete`: both must mutate the target
session's state file and report the outcome to Zettly, and only the handler that
owns that state may do that. Rejected: it would either move the state writes
into the monitor (a second authority) or silently skip them.

## Decisions (mine, stated so they can be corrected)

1. **Explicit target.** `--session <key>` is mandatory for `close`, `drop` and
   `complete`. There is no "current session" default. `list` is the only
   subcommand that runs without a target.
2. **`--dry-run` on every writing subcommand.** Prints the intended change and
   the request it would send, writes nothing. Default is off (`--dry-run` is an
   opt-in flag, not a mode you forget to leave).
3. **`drop` requires `--reason`.** Mirrors the MCP rule that abandoning a task
   must say why.
4. **`complete` passes `--next-steps`, not a free-text summary.** The `complete`
   handler records `dodSummary` computed from the state itself; it accepts no
   summary argument, so a `--summary` flag would be silently ignored. Follow-ups
   are taken as a repeatable `--next-steps` flag and forwarded as `nextSteps`.
5. **Exit code 0 only on real success.** A monitor refusal, an unknown session,
   a missing token, or a dry run that would have failed all exit non-zero, so
   shell scripts can depend on it.
6. **Session state lookup is by key, over the existing layout.** The state file
   is `.../projects/<project>/users/<user>/workflow-state.<key>.json`; the CLI
   discovers candidates the same way `findResumableCandidates` does and refuses
   when the key matches zero or more than one file.
7. **French/Indonesian copy stays out.** Command names, help text, flags and
   output are English, per the repository's implementation-language rule.

## Left to the builder

- Exact output layout (table vs one-line-per-session).
- Whether `share list` is exposed now or later. It is cheap (one GET) and helps
  the owner find the token to revoke, so it is included.
- How much of the monitor's session list to print when there are many rows.
