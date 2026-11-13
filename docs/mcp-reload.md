# Reloading the managed MCP: what to run and what exit code 255 means

Everything below was measured on 12 November 2026, not inferred. It exists because
three separate sessions lost time to the same misunderstanding: OpenCode reported
`dev-workflow` as **failed** with `MCP server process exited with code 255`, and
everyone looked for a crash in the MCP code that was never there.

## Short version

```bash
node managed/rollout.cjs          # publish + promote + sync rules to all devices
node managed/restart-devices.cjs  # kill, reload, reconnect, verify
node managed/fleet-status.cjs     # prove which revision each client resolves
```

Run them from a checkout of this repository. Expect **exactly one interrupted tool
call** on the device you run `restart-devices.cjs` from: the reload bounces the
OpenCode service, and that session reconnects on the new build by itself. The
command no longer hangs waiting for that bounce; see "Why the reload is smooth"
below.

## Why the reload is smooth

Two measurements on HELLOWORLD, 12 November 2026, decided the design:

| Measurement | Value |
|---|---|
| `opencode service restart` returns to its caller | ~0.4 s |
| `GET /api/mcp` answers again after the restart | ~0.9 s |

The command is fast, but the shell that ran it dies with the service it
restarted. Waiting on that shell therefore waits on a dead pipe until the 90 s
timeout and reports `spawnSync powershell ETIMEDOUT` — a failure that never
happened. So:

- **The local restart is requested detached**, with no pipes attached
  (`spawn(..., { detached: true, stdio: 'ignore' })`). Nothing can hang, and the
  script moves on immediately.
- **The reconnect step waits for the service to answer** before judging it:
  `waitForReady` polls `GET /api/mcp` every 500 ms for up to 30 s. A fixed sleep
  would be either too short on a cold start or needlessly slow.
- **The verdict is the reconnect line**, not the exit status of a command that
  killed its own parent. `MCP - <directory>: connected` is the proof.

Remote devices keep the blocking call, because their restart does not kill the
caller.

## Exit code 255 is a force-kill, not a crash

The reload stops stale ManagedMCP processes with `Stop-Process -Id <pid> -Force`,
because a running process keeps the old build in memory. Windows reports that
kill as **exit code 255**, OpenCode records it as `mcp transport error`, and the
server is marked `failed`.

The MCP code is healthy at that moment. Verified on this machine by starting the
managed entry by hand (`bootstrap/device-entry.cjs` -> `launcher.cjs` -> release
`index.js`): it answered `initialize` and `tools/list` with 57 tools and exited 0
when stdin closed. Verified again by the negative case: `Stop-Process -Force` on
the live server PID produced exactly `exited with code 255` and status `failed`.

Other kill shapes report differently, which is how they are told apart:

| How the process died | Reported exit code |
|---|---|
| `Stop-Process -Id ... -Force` | 255 |
| `taskkill /F /IM node.exe /T` | 1 |
| server exits on its own after stdin closes | 0 |

## Why the reload needed a reconnect step

**OpenCode never retries a failed MCP server.** It stays `failed` until something
connects it again, for the rest of the session. `opencode service restart` usually
re-establishes the connection, but "usually" was never checked, so the fleet table
could be green while a session had no dev-workflow tools at all.

`managed/mcp-reconnect.cjs` closes that gap. It:

1. reads `GET /api/mcp` for every project OpenCode touched in the last 24 hours
   (`GET /api/project` -> `canonical`);
2. reconnects **only** servers whose status is `failed`, leaving connected ones
   untouched;
3. re-reads the status after a bounded wait;
4. exits **1** while a server is still failed, so the reload cannot claim success.

`managed/restart-devices.cjs` runs it on every device right after the service
restart, streaming the module over stdin to the Mac and MMCH hosts so no checkout
path is needed there.

Run it on its own at any time:

```bash
node managed/mcp-reconnect.cjs                                  # every active project
node managed/mcp-reconnect.cjs --directory "C:\\Users\\<username>"     # one project
node managed/mcp-reconnect.cjs --since-hours 2 --attempts 5
```

## When a server is still failed

Check the truth first, per location:

```bash
opencode api get "/api/mcp?location[directory]=C:/Users/<username>"
```

Then connect the one server that is down:

```bash
opencode api post "/api/experimental/mcp/dev-workflow/connect?location[directory]=C:/Users/<username>"
```

The `/mcps` screen in the TUI does the same thing. Do not restart the whole
service to fix one server; that bounces every session on the device.

## Rules that come out of this

- Never describe a fleet as up to date from `fleet-status.cjs` alone. It proves
  the process and the resolved revision; only `/api/mcp` proves the connection.
- Never call a `failed` MCP a crash until the exit code and the log line before it
  have been read. 255 means someone killed it on purpose.
- Never wait on a command that restarts the service hosting it. Detach it and
  poll for readiness instead; a timeout there is a measurement artefact, not a
  fault.
- Never fix it by editing `releases/` or the ManagedMCP cache. Ship from git,
  publish through `rollout.cjs`.
- `fleet-status.cjs` says "NOT RUNNING" for a device with no session open. That is
  not a fault; the client picks up the promoted revision on its next start.

## The browser server is pinned

`playwright` used to be configured as `@playwright/mcp@latest`, so every reload
could resolve a different browser server with no record of the change. It is now
pinned to `@playwright/mcp@0.0.85` — the version that was actually running when
the pin was made — in the OpenCode config on all three devices:

| Device | Config |
|---|---|
| HELLOWORLD | `C:\Users\<username>\.config\opencode\opencode.json` |
| MMCH | `C:\Users\mahardhika\.config\opencode\opencode.json` |
| Mac | `/Users/mahardhika/.config/opencode/opencode.json` |

To bump it, change the version in all three files, then read the value back on
each device instead of trusting the write. The pin only takes effect when that
device's MCP starts again.

## The monitors that consume this

- Web dashboard: `http://127.0.0.1:3100`
- Android monitor app: `mobile-app/`, package `com.programinglive.devwfmonitor`,
  see `docs/mobile-app.md` for the build and the Xiaomi Pad 6 install path.
