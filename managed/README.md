# Managed release protocol

`managed/` is the source of the bootstrap that fetches and runs centrally
approved Dev Workflow MCP releases.

## The files

| File | Role |
|---|---|
| `launcher.cjs` | Runs on the device. Fetches the manifest, verifies and unpacks the archive, then spawns the server. |
| `protocol.cjs` | Shared validation: manifest shape and archive path safety. |
| `publish.cjs` | Runs in the repository. Builds the archive and writes `current.json`. |
| `release-server.cjs` | Runs on bw-tools as `devwf-managed.service`, serving `/v1/current` and `/v1/releases/:sha256.tar.gz`. |
| `device-entry.cjs` | Thin per-client entry point that calls the launcher. |
| `install-device.py` | Installs the bootstrap into a device's `%LOCALAPPDATA%\ProgramingLive\ManagedMCP`. |
| `devwf-managed.service` | systemd unit for the release server. |

## Restarting the fleet

The MCP is a child of the AI CLI. A running CLI cannot be handed a new MCP, so
"restart" always means: stop the MCP, stop the CLI, start the CLI, verify. There
is no shortcut, and pretending otherwise is what left devices on old releases.

Two commands, run from a checkout of this repository:

```bash
node managed/restart-devices.cjs   # stops ManagedMCP on HELLOWORLD, Mac and MMCH
node managed/fleet-status.cjs      # proves what each device and client will run
```

`restart-devices.cjs` deliberately does **not** relaunch the CLIs: they are
interactive terminal programs, and a relaunch over SSH lands in the wrong
session. It prints the exact per-CLI instruction instead.

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

> Run `node managed/restart-devices.cjs`, then tell me the exact commands I must
> paste to reopen each CLI, then run `node managed/fleet-status.cjs` and show me
> the table.

That gives the agent three concrete actions and a verifiable end state, so it
does not have to invent a procedure.

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
The launcher actually running on the device defaults to `100.77.138.14:3101`.
Taking the `/tmp` copy as the base would have pointed every device at a dead
address. The base here is the launcher read back from the running device.

**This code previously existed only in `/tmp`.** A reboot would have destroyed
the only copy of the release protocol. It lives here now.

## Deploying a change

```bash
# 1. publish from a clean tree
node managed/publish.cjs /var/lib/devwf-releases

# 2. install the server files on bw-tools
sudo install -o devwf-releases -g devwf-releases -m 640 \
  managed/protocol.cjs managed/release-server.cjs /opt/devwf-managed/
sudo systemctl restart devwf-managed

# 3. verify
curl -s -H "authorization: Bearer $TOKEN" http://100.77.138.14:3101/v1/current
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
