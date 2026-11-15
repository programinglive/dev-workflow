# Managed release protocol

`managed/` is the source of the bootstrap that fetches and runs centrally
approved Dev Workflow MCP releases.

## The files

| File | Role |
|---|---|
| `launcher.cjs` | Runs on the device. Fetches the manifest, verifies and unpacks the archive, then spawns the server. |
| `protocol.cjs` | Shared validation: manifest shape and archive path safety. |
| `publish.cjs` | Runs in the repository. Builds the archive and writes `current.json`. |
| `release-server.cjs` | Runs on build-host.example as `devwf-managed.service`, serving `/v1/current` and `/v1/releases/:sha256.tar.gz`. |
| `device-entry.cjs` | Thin per-client entry point that calls the launcher. |
| `admission.cjs` | Maintenance admission gate and its operator CLI. |
| `install-device.py` | Installs the bootstrap into a device's `%LOCALAPPDATA%\ProgramingLive\ManagedMCP`. |
| `devwf-managed.service` | systemd unit for the release server. |

## Maintenance admission

A fleet cutover replaces the release every managed client runs. Without a gate,
a client that starts mid-cutover can resolve a half-installed release or pin a
revision the operator is about to replace. `admission.cjs` is that gate.

The marker is `maintenance-admission.json` in the managed cache root
(`%LOCALAPPDATA%\ProgramingLive\ManagedMCP` on Windows). `DEVWF_MANAGED_ROOTS`
adds more roots, and `DEVWF_MAINTENANCE_ADMISSION` names one explicit file.

```json
{ "schemaVersion": 1, "mode": "draining", "reason": "fleet cutover",
  "startedAt": "2026-11-16T00:00:00Z", "expiresAt": "2026-11-16T02:00:00Z" }
```

| Mode | Effect |
|---|---|
| `open` | Launches are admitted. |
| `draining` | New launches are refused; running sessions are left alone. |
| `cutover` | New launches are refused outright. Reopen with `open` or `clear` once the swap is verified. |

Operator CLI:

```bash
node managed/admission.cjs status
node managed/admission.cjs drain --reason "fleet cutover" --expires 2026-11-16T02:00:00Z
node managed/admission.cjs cutover --reason "swap to <rev>"
node managed/admission.cjs open
node managed/admission.cjs clear
```

Rules that matter:

- **Fail closed.** A marker that exists but cannot be read, parsed or understood
  is treated as maintenance, never as permission. A damaged marker blocks the
  fleet until an operator clears it. A dangling symlink at the marker path
  counts as "exists but unreadable", not as absent.
- **Expiry is not permission.** An expired window reports `ADMISSION_STALE` and
  keeps refusing. The clock never reopens the fleet on its own.
- **Cutover is a hard stop.** `cutover` refuses every new launch. It is not
  "allow the target revision": the device entry cannot prove which revision it
  is about to run, so any revision exception would be unreachable through the
  configured entry point and would only create a bypass. Reopen with `open` or
  `clear` after the swap is verified.
- **Race-safe selection.** The launcher fingerprints the marker before and after
  release selection. If it moved, the launch is abandoned (`ADMISSION_CHANGED`)
  instead of racing the cutover.
- **Spawn-race guard.** A window can still open in the gap between the final
  check and process creation. The launcher re-checks immediately after spawn and
  stops the child it just started. Only a child this launcher created is ever
  stopped; running sessions are untouched.
- **Cached launchers are covered as far as code can cover them.** `device-entry.cjs`
  checks admission before it starts `launcher.cjs`, and re-checks after the
  spawn, stopping the launcher it just started if a window opened in the gap.
  `install-device.py` points credential wrappers at `device-entry.cjs` and ships
  `admission.cjs` beside it, so the installed entry always has the gate.
  `resolveRelease` checks again for any other caller.
  The residual limit is physical: a launcher copy older than this gate, invoked
  directly by a hand-edited client config, cannot be made to check anything.
  Reinstall the device, or fix that client to point at `device-entry.cjs`.
- **What it cannot do.** It cannot stop an unmodified legacy client that runs
  `index.js` directly, and it cannot terminate a running process. It only
  refuses new launches.

Rollback: `clear` the marker, or set `mode: "open"`. Both restore launches
immediately.

## Restarting the fleet

The MCP is a child of the AI CLI. It cannot be handed a new release while the
CLI is running, but **not every client needs a window restart**:

| Client | How a new release is picked up |
|---|---|
| OpenCode | `opencode service restart` — the TUI reconnects on its own |
| Codex | no reload command; close that one app and start it again |
| Antigravity | no reload command; close that one app and start it again |

One command does the whole fleet:

```bash
node managed/restart-devices.cjs
```

It stops stale ManagedMCP processes on HELLOWORLD, Mac and MMCH, then runs
`opencode service restart` on each device. Codex and Antigravity are reported as
needing their own restart rather than being silently skipped. Finally it runs
`managed/fleet-status.cjs` and prints the table.

The force-kill is deliberate, and it is also why a reload can look successful
while the session has no dev-workflow tools: Windows reports the kill as exit
code 255, OpenCode records it as a transport error and marks the server
`failed`, and OpenCode never retries a failed server. `opencode service restart`
usually reconnects it, but "usually" is not a check. So after the restart the
reload runs `managed/mcp-reconnect.cjs` on each device: it reads `/api/mcp` for
every project OpenCode touched in the last 24 hours, reconnects only the servers
that report `failed`, re-reads the status, and exits non-zero when one is still
down. A green table now means connected, not merely "ManagedMCP is running".

Run the same check by hand at any time, and add `--directory` when you want a
single project instead of every active one:

```bash
node managed/mcp-reconnect.cjs
node managed/mcp-reconnect.cjs --directory "C:\\Users\\<username>"
```

The measured reload procedure, the exit code table and the recovery commands live
in `docs/mcp-reload.md`.

**Expect one interrupted tool call on the device you run it from.** Restarting
the OpenCode service bounces the connection of the session that issued the
command. The session reconnects and the MCP comes back on the new release; the
in-flight command is the only casualty. Do not treat that abort as a failure —
re-run `node managed/fleet-status.cjs` to confirm.

`fleet-status.cjs` answers three questions with facts and never guesses:

| It reports | Why it matters |
|---|---|
| ManagedMCP running or not, per device | After a restart this must say `running` |
| The revision each of `opencode`, `codex`, `antigravity` resolves to | Proves the release the next CLI start will load |
| Whether every device agrees | Catches the one-device-left-behind failure |

It is read-only: it starts nothing and kills nothing. Exit code 1 means a device
is unreachable or a client would resolve a different revision.

### What to tell the agent

When an agent has lost the MCP, do not ask it to "restart". Say:

> Run `node managed/restart-devices.cjs`, then show me the fleet-status table.

That gives the agent one command, a known side effect it will not mistake for a
failure, and a verifiable end state.

### Checking client registrations

`fleet-status.cjs` proves which revision the bootstrap resolves. It does not
prove that a client actually registers `dev-workflow`. A client whose MCP
config file is empty loads no servers at all, so its tasks never reach the
monitor while the fleet table stays green.

```sh
python managed/install-device.py --doctor
```

The doctor is read-only. It reports one state per client config file
(`missing`, `empty`, `invalid`, `no-entry`, `ok`) and exits 1 when a present
file is empty, invalid or has no `dev-workflow` entry. Antigravity has two
files: the IDE reads `~/.gemini/antigravity/mcp_config.json` and the CLI (`agy`)
reads `~/.gemini/config/mcp_config.json`. The installer rewrites a
`dev-workflow` entry in either file, but never overwrites an empty or invalid
file; repair those with the client's own command, for example:

```sh
agy mcp add --env DEVWF_AGENT=antigravity dev-workflow <node> <bootstrap>/device-entry.cjs antigravity
```

## The manifest

```json
{ "revision": "<40 hex>", "sha256": "<64 hex>", "size": 4157680, "version": "1.28.0" }
```

`version` is optional so a publisher running an older build still works. When
it is present it must be semver (`MAJOR.MINOR.PATCH`, optional prerelease and
build metadata). A leading `v` is rejected deliberately: the value is compared
across devices, so one writer adding `v` would make every other device look out
of sync.

`protocol.cjs` returns the field rather than dropping it. Before this, the
validator rebuilt the object from `revision`, `sha256` and `size` only, so
nothing else could ever reach a client â€” which is why answering "which version
is running here?" needed an SSH session per device.

## Version flow

```
package.json at the published commit
      -> publish.cjs        writes version into current.json
      -> release-server.cjs validates and forwards it
      -> launcher.cjs       stores it in last-good.json, exports DEVWF_RELEASE_VERSION
      -> monitor.js         includes releaseVersion in the session snapshot
      -> sessions table     release_version, release_revision
      -> dashboard          shows the version per device
```

## Two lessons from recovering this source

**The working copy in `/tmp` was stale.** It defaulted
`DEVWF_RELEASE_URL` to `100.78.134.44:3101`, a host that has since been deleted.
The launcher actually running on the device defaults to `127.0.0.1:3101`.
Taking the `/tmp` copy as the base would have pointed every device at a dead
address. The base here is the launcher read back from the running device.

**This code previously existed only in `/tmp`.** A reboot would have destroyed
the only copy of the release protocol. It lives here now.

## Deploying a change

```bash
# 1. publish from a clean tree
node managed/publish.cjs /var/lib/devwf-releases

# 2. install the server files on build-host.example
sudo install -o devwf-releases -g devwf-releases -m 640 \
  managed/protocol.cjs managed/release-server.cjs /opt/devwf-managed/
sudo systemctl restart devwf-managed

# 3. verify
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:3101/v1/current
```

Devices pick the new manifest up on their next start. The version appears in
`last-good.json` and in the session report.

## Restarting the MCP on all devices

See [Restarting the fleet](#restarting-the-fleet) above. It is the single
authoritative procedure: stop the MCP, stop the CLI, start the CLI, verify with
`fleet-status.cjs`. Do not restart one device by hand and leave the others on an
old release; that is how a device ends up reporting a version the fleet no
longer runs.

## Backward compatibility

An old device launcher ignores an unknown `version` key, and it validates the
manifest through the same `protocol.cjs`, which accepts a versionless manifest.
An old publisher emits no `version`, and the monitor stores an empty string
rather than inventing one.
