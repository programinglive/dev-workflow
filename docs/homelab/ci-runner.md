# Self-Hosted CI Runner (bw-tools)

CI for this repo runs on **bw-tools** (`100.77.138.14`, Linux Ubuntu), not on GitHub-hosted minutes. GitHub-hosted
runners cost build minutes we are not paying for, and the project builds fine on
hardware we already own.

The former Windows runner on MMCH (`100.109.164.16`) has been decommissioned and migrated to bw-tools.

---

## Runner inventory

| Item | Value |
|---|---|
| Name | `bwtools-devwf` |
| Labels | `self-hosted`, `Linux`, `X64`, `bwtools`, `bw-tools`, `dev-workflow-mcp-server` |
| Version | 2.338.2 |
| Install path | `/home/dhika/actions-runner-devwf` |
| Host | bw-tools — Linux Ubuntu, `100.77.138.14` |
| Service | `actions.runner.programinglive-dev-workflow-mcp-server.bwtools-devwf.service` |

Workflow jobs target `runs-on: [self-hosted, linux, bw-tools]`.

---

## Why a scheduled task instead of a Windows service

Runner build 2.338 does **not** ship `svc.cmd` on Windows — the archive contains
only `config.cmd` and `run.cmd`. `bin\RunnerService.exe` also refuses to install
on its own:

```
Cannot start service from the command line or a debugger.
A Windows Service must first be installed (using installutil.exe)
```

So the runner is hosted by a scheduled task:

```
Task:     GitHubActionsRunner-MMCH
Trigger:  At startup
Run as:   SYSTEM, highest privileges
Action:   cmd.exe /c cd /d C:\actions-runner && run.cmd
```

`run.cmd` re-launches the listener when it exits, so the runner survives
crashes. If you later want a true service, install it with `installutil.exe`
against `bin\RunnerService.exe`.

---

## Host prerequisites

These are what MMCH needed. A fresh machine will need the same.

| Requirement | Notes |
|---|---|
| Node.js 24.x | `better-sqlite3` 12.x ships prebuilds for Node 24 (`node-v137`). |
| npm 11.x | Installed with Node. |
| Git for Windows | `git version 2.55.0.windows.5` on MMCH. |
| Execution policy `RemoteSigned` | The runner executes generated `.ps1` files; `Restricted` fails the job. |
| No Visual Studio needed | Only true because `better-sqlite3` >= 12 is used. 11.x has no Node 24 prebuild and would compile from source. |

Set the execution policy for both machine and user scope:

```powershell
Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force
Set-ExecutionPolicy -Scope CurrentUser  -ExecutionPolicy RemoteSigned -Force
```

---

## Registering the runner

Run on MMCH, in an elevated shell. The registration token comes from
`gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token`
and expires after one hour.

```powershell
$RunnerDir = 'C:\actions-runner'
$Version   = '2.338.1'
$Zip       = "$env:TEMP\actions-runner-win-x64-$Version.zip"

Invoke-WebRequest `
  -Uri "https://github.com/actions/runner/releases/download/v$Version/actions-runner-win-x64-$Version.zip" `
  -OutFile $Zip -UseBasicParsing

# Verify before extracting - see the release notes for the expected hash.
(Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()

New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $RunnerDir)

Set-Location $RunnerDir
.\config.cmd --unattended `
  --url https://github.com/programinglive/dev-workflow-mcp-server `
  --token <REGISTRATION_TOKEN> `
  --name mmch-dev-workflow `
  --labels self-hosted,windows,mmch `
  --work _work --replace
```

`config.cmd` writes `.runner`, `.credentials` and `.credentials_rsaparams` into
the install directory. **Do not delete that directory to re-extract the
archive** — it removes the credentials while the runner stays registered on
GitHub, leaving it permanently offline. Re-run `config.cmd --replace` instead.

---

## Verifying

```bash
gh api repos/programinglive/dev-workflow-mcp-server/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Expected:

```json
{"name":"mmch-dev-workflow","status":"online","labels":["self-hosted","Windows","X64","mmch"]}
```

On the machine itself:

```powershell
schtasks /Query /TN GitHubActionsRunner-MMCH /FO LIST
Get-Process Runner.Listener -ErrorAction SilentlyContinue
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Job queued forever | Runner offline | `schtasks /Run /TN GitHubActionsRunner-MMCH` |
| `pwsh: command not found` | Only the Windows PowerShell 5.1 stub exists | Use `shell: powershell` in the workflow |
| `cannot be loaded because running scripts is disabled` | Execution policy | Set `RemoteSigned` as above, then restart the task |
| `npm ci` says lockfile out of sync | A peer dependency is undeclared | Declare it in `package.json`; do not just regenerate the lock locally |
| `gyp ERR! find VS` | Native module compiling from source | Check a prebuilt exists for the Node ABI in use, or install VS Build Tools |
| `EPERM ... better_sqlite3.node` | A running process holds the file | Stop the process, then reinstall |

---

## Updating the runner

```powershell
schtasks /End /TN GitHubActionsRunner-MMCH
# download and extract the new version over C:\actions-runner
# (do not delete the directory - it holds the credentials)
schtasks /Run /TN GitHubActionsRunner-MMCH
```
