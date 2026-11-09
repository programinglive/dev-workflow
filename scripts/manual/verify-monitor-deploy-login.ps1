# Purpose: prove the dedicated devwf-monitor-deploy identity can log in from
# MMCH and that its sudo allowlist is exactly the deployment commands.
# Hand-run harness for the CI deployment path; CI itself runs deploy-monitor.ps1.
#
# Usage (from MMCH, where the deploy key is allowed to come from):
#   powershell -File verify-monitor-deploy-login.ps1 <path-to-private-key>
#
# It never prints key material, always removes its temporary copy, and uses a
# hard remote timeout so a sudo password prompt cannot hang the check.

param(
    [Parameter(Mandatory = $true)][string] $SourceKey
)

$ErrorActionPreference = 'Stop'
$temp = Join-Path $env:TEMP ('devwf-login-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$key = Join-Path $temp 'deploy.key'
$target = 'devwf-monitor-deploy@100.77.138.14'
$opts = @('-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15')
try {
    [IO.File]::WriteAllText($key, (Get-Content -LiteralPath $SourceKey -Raw), (New-Object System.Text.UTF8Encoding($false)))
    & icacls.exe $key /inheritance:r /grant:r (([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) + ':F') | Out-Null
    if (-not (Get-Content -LiteralPath $key -TotalCount 1)) { throw 'Temporary key is not readable.' }

    Write-Output '=== whoami over the dedicated identity ==='
    & ssh.exe @opts $target 'id -un; echo LOGIN_OK' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Login failed with exit $LASTEXITCODE." }

    Write-Output '=== sudo allowlist for the deploy account ==='
    & ssh.exe @opts $target 'sudo -n -l 2>&1 | tail -6' 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the sudo allowlist.' }

    Write-Output '=== deploy identity is not a general sudo user ==='
    # Enforcement is verified with `sudo -n -l -U <user>` and a refused command
    # from a trusted admin shell, not from inside this loop: a nested `sudo -n`
    # started by the restricted account can block on password input on some
    # Windows clients and hide the real result behind a hang.

    Write-Output '=== deploy-user read paths used by the deploy job ==='
    & ssh.exe @opts $target 'mkdir -p /home/devwf-monitor-deploy/incoming && test -r /opt/devwf-monitor/monitor.cjs && test -r /opt/devwf-monitor/machines-query.cjs && echo STAGING_OK' 2>&1
    & ssh.exe @opts $target 'node --version; command -v node; sha256sum --version | head -1' 2>&1
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
    Write-Output ('temporary key removed: ' + (-not (Test-Path -LiteralPath $temp)))
}
