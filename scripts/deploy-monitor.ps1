$ErrorActionPreference = 'Stop'

# Deploys the reviewed monitor artifacts to bw-tools through the dedicated
# devwf-monitor-deploy identity and the narrow sudo allowlist.
#
# Rules this script keeps:
# 1. The private key is written to the runner temp directory, is readable by the
#    account running ssh, and is deleted in `finally` whatever happens. It is
#    never printed, echoed into a command line, or committed.
# 2. The host key is pinned in the repository; StrictHostKeyChecking is on.
# 3. Only files this job actually publishes are installed, and every module the
#    changed artifacts require is published too. A partial deploy that leaves
#    the service on mixed versions is a broken deploy, not a smaller one.
# 4. The previous files are copied before installation so a failed verification
#    can restore them, and the restore path uses the same allowlisted commands.
# 5. Verification happens against the live process, not against the staging
#    copy: hashes, syntax, health, session data and the close control.

$repoRoot = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $repoRoot 'monitor-server/dashboard.cjs'
$machines = Join-Path $repoRoot 'monitor-server/machines-query.cjs'
$knownHosts = Join-Path $repoRoot 'monitor-server/bw-tools-known-hosts'
$keyPath = Join-Path $env:RUNNER_TEMP 'devwf-monitor-deploy.key'
$target = 'devwf-monitor-deploy@100.77.138.14'
$incoming = '/home/devwf-monitor-deploy/incoming'
$baseUrl = 'http://100.77.138.14:3100'
$sshOptions = @('-n', '-i', $keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts")
# `scp` has no `-n`; without it the copy inherits stdin and can block the same
# way a captured ssh call does, so the copy gets its own guarded option list.
$scpOptions = @('-q', '-i', $keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts")
# Staged names are the ones the sudo allowlist names exactly. `monitor` is the
# installed name of dashboard.cjs on the server.
$artifacts = @(
    [pscustomobject]@{ Local = $dashboard; Staged = 'monitor.cjs'; Installed = '/opt/devwf-monitor/monitor.cjs' },
    [pscustomobject]@{ Local = $machines; Staged = 'machines-query.cjs'; Installed = '/opt/devwf-monitor/machines-query.cjs' }
)
$deployed = $false

function Quote-Argument {
    param([string] $Value)
    if ($Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}

# Runs a native command with its output redirected to files.
#
# `& ssh.exe ...` inside a function can block forever on the self-hosted runner:
# the child inherits the runner's stdin and the captured pipeline never closes,
# so the job sits there until its timeout even though the remote command already
# finished. Redirecting the streams and waiting on the process is deterministic,
# and the explicit timeouts make a dead connection fail instead of hang.
function Invoke-Native {
    param(
        [string] $FilePath,
        [string[]] $Arguments,
        [string] $Description
    )
    $outFile = Join-Path $env:RUNNER_TEMP 'monitor-deploy.out'
    $errFile = Join-Path $env:RUNNER_TEMP 'monitor-deploy.err'
    $argumentLine = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $process = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $stdout = @()
    if (Test-Path -LiteralPath $outFile) { $stdout = @(Get-Content -LiteralPath $outFile) }
    $stderr = ''
    if (Test-Path -LiteralPath $errFile) { $stderr = (Get-Content -LiteralPath $errFile -Raw) }
    if ($process.ExitCode -ne 0) {
        throw "$Description failed ($($process.ExitCode)): $($stderr.Trim())"
    }
    return $stdout
}

function Invoke-DeploySsh {
    param([string] $RemoteCommand)
    return Invoke-Native -FilePath 'ssh.exe' -Arguments (@($sshOptions) + @($target, $RemoteCommand)) -Description "ssh: $RemoteCommand"
}

function Send-DeployFile {
    param([string] $LocalPath, [string] $RemotePath)
    Invoke-Native -FilePath 'scp.exe' -Arguments (@($scpOptions) + @($LocalPath, "${target}:${RemotePath}")) -Description "scp: $RemotePath" | Out-Null
}

function Get-RemoteHash {
    param([string] $Name)
    $line = Invoke-DeploySsh "sha256sum $incoming/$Name"
    if ($line -match '^([0-9a-fA-F]{64})') { return $Matches[1].ToLowerInvariant() }
    throw "Could not read the uploaded hash of $Name."
}

try {
    if ([string]::IsNullOrWhiteSpace($env:MONITOR_DEPLOY_SSH_KEY)) {
        throw 'MONITOR_DEPLOY_SSH_KEY is missing.'
    }
    if (-not (Test-Path -LiteralPath $knownHosts)) {
        throw "The pinned host key file is missing: $knownHosts"
    }
    foreach ($artifact in $artifacts) {
        if (-not (Test-Path -LiteralPath $artifact.Local)) {
            throw "Reviewed artifact is missing: $($artifact.Local)"
        }
    }

    [System.IO.File]::WriteAllText($keyPath, $env:MONITOR_DEPLOY_SSH_KEY.TrimEnd() + "`n", (New-Object System.Text.UTF8Encoding($false)))
    # Remove inherited ACEs, then grant the current account full control. The
    # process that runs ssh must be able to READ the key; an ACL that leaves only
    # SYSTEM makes ssh fail with "Permission denied" while looking like a
    # credentials problem. This ordering is the whole point: ACL first, upload
    # second, and assert readability before spending a network round trip.
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $keyPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the SSH key file ACL.' }
    if (-not (Get-Content -LiteralPath $keyPath -TotalCount 1)) {
        throw 'The SSH key file is not readable after applying its ACL.'
    }

    Invoke-DeploySsh "mkdir -p $incoming" | Out-Null

    # Snapshot the installed files before anything is replaced.
    Invoke-DeploySsh "cp /opt/devwf-monitor/monitor.cjs $incoming/monitor.previous.cjs" | Out-Null
    Invoke-DeploySsh "cp /opt/devwf-monitor/machines-query.cjs $incoming/machines-query.previous.cjs" | Out-Null

    foreach ($artifact in $artifacts) {
        Send-DeployFile $artifact.Local "$incoming/$($artifact.Staged)"
        $remote = Get-RemoteHash $artifact.Staged
        $local = (Get-FileHash -LiteralPath $artifact.Local -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($remote -ne $local) {
            throw "Uploaded hash for $($artifact.Staged) does not match the reviewed checkout."
        }
        Invoke-DeploySsh "node --check $incoming/$($artifact.Staged)" | Out-Null
    }

    $deployed = $true
    foreach ($artifact in $artifacts) {
        Invoke-DeploySsh "sudo -n /usr/bin/install -m 644 $incoming/$($artifact.Staged) $($artifact.Installed)" | Out-Null
    }
    Invoke-DeploySsh 'sudo -n /usr/bin/systemctl restart devwf-monitor.service' | Out-Null

    $health = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            $health = Invoke-WebRequest "$baseUrl/health" -UseBasicParsing -TimeoutSec 10
            if ($health.StatusCode -eq 200) { break }
        } catch {
            $health = $null
        }
        Start-Sleep -Seconds 2
    }
    if (-not $health -or $health.StatusCode -ne 200) {
        throw 'Monitor health endpoint did not return HTTP 200 after the restart.'
    }

    $sessions = Invoke-RestMethod "$baseUrl/api/sessions" -TimeoutSec 15
    if (@($sessions.machines | Where-Object { $_.machine -eq 'uji' }).Count -ne 0) {
        throw 'The retired test machine is still visible.'
    }
    if (@($sessions.alerts | Where-Object { $_.machine -eq 'uji' }).Count -ne 0) {
        throw 'The retired test machine still emits an alert.'
    }

    $page = Invoke-WebRequest "$baseUrl/" -UseBasicParsing -TimeoutSec 15
    if ($page.Content -notmatch 'closeBtn\.disabled = false') {
        throw 'The live dashboard does not contain the close-control reset.'
    }
    Write-Output 'Monitor deployment verified: health 200, retired test machine absent, close control reset present.'
} catch {
    if ($deployed) {
        try {
            Invoke-DeploySsh "sudo -n /usr/bin/install -m 644 $incoming/monitor.previous.cjs /opt/devwf-monitor/monitor.cjs" | Out-Null
            Invoke-DeploySsh "sudo -n /usr/bin/install -m 644 $incoming/machines-query.previous.cjs /opt/devwf-monitor/machines-query.cjs" | Out-Null
            Invoke-DeploySsh 'sudo -n /usr/bin/systemctl restart devwf-monitor.service' | Out-Null
            Write-Warning 'Restored the previous monitor files after the deployment check failed.'
        } catch {
            Write-Warning 'Automatic monitor rollback failed; manual recovery is required.'
        }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath -Force }
}
