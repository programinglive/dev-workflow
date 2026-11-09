$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $repoRoot 'monitor-server/dashboard.cjs'
$machines = Join-Path $repoRoot 'monitor-server/machines-query.cjs'
$knownHosts = Join-Path $repoRoot 'monitor-server/bw-tools-known-hosts'
$keyPath = Join-Path $env:RUNNER_TEMP 'devwf-monitor-deploy.key'
$target = 'devwf-monitor-deploy@100.77.138.14'
$incoming = '/home/devwf-monitor-deploy/incoming'
$sshOptions = @('-i', $keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts")
$deployed = $false

function Invoke-DeploySsh {
    param([string] $RemoteCommand)
    $output = & ssh.exe @sshOptions $target $RemoteCommand
    if ($LASTEXITCODE -ne 0) { throw "Monitor SSH command failed ($LASTEXITCODE): $RemoteCommand" }
    return $output
}

try {
    if ([string]::IsNullOrWhiteSpace($env:MONITOR_DEPLOY_SSH_KEY)) {
        throw 'MONITOR_DEPLOY_SSH_KEY is missing.'
    }
    [System.IO.File]::WriteAllText($keyPath, $env:MONITOR_DEPLOY_SSH_KEY.TrimEnd() + "`n", (New-Object System.Text.UTF8Encoding($false)))
    & icacls.exe $keyPath /inheritance:r /grant:r '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the SSH key file ACL.' }

    Invoke-DeploySsh 'mkdir -p /home/devwf-monitor-deploy/incoming' | Out-Null
    Invoke-DeploySsh 'cp /opt/devwf-monitor/monitor.cjs /home/devwf-monitor-deploy/incoming/monitor.previous.cjs' | Out-Null
    Invoke-DeploySsh 'cp /opt/devwf-monitor/machines-query.cjs /home/devwf-monitor-deploy/incoming/machines-query.previous.cjs' | Out-Null

    & scp.exe @sshOptions $dashboard "${target}:${incoming}/monitor.cjs"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload dashboard.cjs.' }
    & scp.exe @sshOptions $machines "${target}:${incoming}/machines-query.cjs"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload machines-query.cjs.' }

    $remoteHashes = Invoke-DeploySsh "sha256sum $incoming/monitor.cjs $incoming/machines-query.cjs"
    $hashes = @{}
    foreach ($line in $remoteHashes) {
        if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
            $hashes[$Matches[2]] = $Matches[1].ToLowerInvariant()
        }
    }
    if ($hashes["$incoming/monitor.cjs"] -ne (Get-FileHash $dashboard -Algorithm SHA256).Hash.ToLowerInvariant() -or
        $hashes["$incoming/machines-query.cjs"] -ne (Get-FileHash $machines -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw 'Uploaded monitor artifact hashes do not match the reviewed checkout.'
    }

    Invoke-DeploySsh "node --check $incoming/monitor.cjs" | Out-Null
    Invoke-DeploySsh "node --check $incoming/machines-query.cjs" | Out-Null

    $deployed = $true
    Invoke-DeploySsh "sudo -n /usr/bin/install -m 644 $incoming/monitor.cjs /opt/devwf-monitor/monitor.cjs" | Out-Null
    Invoke-DeploySsh "sudo -n /usr/bin/install -m 644 $incoming/machines-query.cjs /opt/devwf-monitor/machines-query.cjs" | Out-Null
    Invoke-DeploySsh 'sudo -n /usr/bin/systemctl restart devwf-monitor.service' | Out-Null

    $health = Invoke-WebRequest 'http://100.77.138.14:3100/health' -UseBasicParsing -TimeoutSec 15
    if ($health.StatusCode -ne 200) { throw 'Monitor health endpoint did not return HTTP 200.' }
    $sessions = Invoke-RestMethod 'http://100.77.138.14:3100/api/sessions' -TimeoutSec 15
    if (@($sessions.machines | Where-Object { $_.machine -eq 'uji' }).Count -ne 0) {
        throw 'The retired test machine is still visible.'
    }
    if (@($sessions.alerts | Where-Object { $_.machine -eq 'uji' }).Count -ne 0) {
        throw 'The retired test machine still emits an alert.'
    }
    $page = Invoke-WebRequest 'http://100.77.138.14:3100/' -UseBasicParsing -TimeoutSec 15
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
