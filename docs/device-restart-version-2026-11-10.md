# Restarting all three devices onto the version-carrying launcher

Date: **10 November 2026**.

## Why a restart was needed

The launcher is the program OpenCode starts when it spawns the Dev Workflow MCP
server. A running server keeps the environment it was started with, so
`DEVWF_RELEASE_VERSION` only reaches `monitor.js` on the next start. Deploying
the file is not enough; the process has to be replaced.

## Bootstrap deployment

Every device now carries the same pair, which must be replaced together:

| Device | launcher.cjs | protocol.cjs | Rollback copies |
|---|---|---|---|
| MMCH | 9920 B | 2038 B | `.bak-20261110-080523`, `.bak-20261110-080609` |
| HELLOWORLD | 9920 B | 2038 B | `.bak-20261110-082652` |
| Mac | 9920 B | 2038 B | `.bak-20261110` (recovered from git `718c4e7`) |

The Mac and HELLOWORLD backups were reconstructed from git rather than copied
first: on Mac the inline `$(date)` was expanded by PowerShell before reaching the
remote shell, and on HELLOWORLD the first scheduled-task registration did not
persist. Both recovered copies are the real previous files (9498 B launcher,
1057 B protocol), taken from commit `718c4e7`.

## How each device was restarted

**Mac** runs the desktop bundle `/Applications/opencode.app`, not the CLI. After
`pkill`, it came back with `open -a opencode`, which asks launchd to start it in
the logged-in GUI session. A plain `opencode` relaunch from ssh does nothing
because the binary is not on the non-interactive PATH.

**HELLOWORLD** runs `OpenCode.exe` from
`%LOCALAPPDATA%\Programs\ai.opencode.desktop`. Because the ssh shell comes from
sshd and is not a descendant of OpenCode, a direct `taskkill` followed by
`Start-Process` is safe there — the scheduled-task trick is only needed when the
killer lives inside the tree it is killing, which is the MMCH case.

**MMCH** needed the scheduled task, because the only shell available is a
descendant of the OpenCode process being replaced.

## Result

```
Mac          version="1.28.0"   rev=ef1c952f7150
HELLOWORLD   version="1.28.0"   rev=ef1c952f7150
MMCH         version=""         (restart scheduled after this note)
```

Before the restart the same query returned `version=""` for all three, and 61
HELLOWORLD rows and 26 Mac rows carried an empty version. The change is visible
in the data, not just in the configuration.

## A detail worth knowing

`release_revision` was already populated on HELLOWORLD before the restart
(`rev=ef1c952f7150` with `version=""`) — older rows show the revision because
`DEVWF_RELEASE_REVISION` has been exported for a long time, while
`DEVWF_RELEASE_VERSION` is new. That asymmetry is the cleanest proof that the
version really is a new field and not a re-reading of something already there.

## Rollback

Per device:

```bash
# Mac
cp ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/launcher.cjs.bak-20261110 \
   ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/launcher.cjs
cp ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/protocol.cjs.bak-20261110 \
   ~/.local/share/ProgramingLive/ManagedMCP/bootstrap/protocol.cjs
```

```powershell
# HELLOWORLD and MMCH
$b = Join-Path $env:LOCALAPPDATA 'ProgramingLive\ManagedMCP\bootstrap'
Copy-Item "$b\launcher.cjs.bak-*" "$b\launcher.cjs" -Force
Copy-Item "$b\protocol.cjs.bak-*" "$b\protocol.cjs" -Force
```

Restarting again with the old pair would also restore the old behaviour of
pointing at `100.78.134.44` on the `/tmp` copy — but the backups here were taken
from commit `718c4e7`, which already uses `127.0.0.1`.
