# ==============================================================================
# Programinglive Homelab Bootstrap Script for Windows (HELLOWORLD)
# Installs: RTK (Token Killer), Superpowers (Skills), and Dev-Workflow MCP
#
# This script is a thin wrapper. All OpenCode configuration logic lives in
# scripts/setup-stack.js so Windows and macOS cannot drift apart.
# ==============================================================================

$ErrorActionPreference = 'Stop'

Write-Host "🚀 Starting Homelab Windows Bootstrap on HELLOWORLD..." -ForegroundColor Cyan

$repoRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $repoRoot 'scripts\setup-stack.js'

if (!(Test-Path $setupScript)) {
    Write-Host "✗ Could not find $setupScript" -ForegroundColor Red
    Write-Host "  Run this script from inside a clone of dev-workflow-mcp-server." -ForegroundColor Red
    exit 1
}

# 1. Ensure Node is available (setup-stack.js is a Node script)
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "✗ Node.js not found on PATH. Install Node 20+ and re-run." -ForegroundColor Red
    exit 1
}

# 2. Check / install RTK
if (!(Get-Command rtk -ErrorAction SilentlyContinue)) {
    Write-Host "⚡ Installing RTK via winget..." -ForegroundColor Yellow
    try {
        winget install rtk-ai.rtk --accept-source-agreements --accept-package-agreements
    } catch {
        Write-Host "⚠️ winget install failed. Install RTK manually, then re-run." -ForegroundColor Yellow
    }

    # winget updates PATH for new shells only; refresh this process so rtk resolves.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
} else {
    Write-Host "✓ RTK is already installed." -ForegroundColor Green
}

# 3. Install dependencies BEFORE the MCP server is registered, otherwise the
#    server crashes at startup with ERR_MODULE_NOT_FOUND.
Write-Host "📥 Installing dependencies..." -ForegroundColor Yellow
Push-Location $repoRoot
try {
    if (!(Test-Path (Join-Path $repoRoot 'node_modules'))) {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Host "✗ npm install failed. The MCP server cannot start without dependencies." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "✓ Dependencies already installed." -ForegroundColor Green
    }
} finally {
    Pop-Location
}

# 4. Configure the stack (config path, plugins, MCP server, RTK hook, verification)
Write-Host "`n⚙️ Configuring OpenCode..." -ForegroundColor Yellow
node $setupScript
$setupExit = $LASTEXITCODE

if ($setupExit -ne 0) {
    Write-Host "`n✗ Setup did not complete successfully (exit $setupExit)." -ForegroundColor Red
    exit $setupExit
}

Write-Host "`n=============================================================" -ForegroundColor Cyan
Write-Host "🎉 HELLOWORLD HOMELAB BOOTSTRAP COMPLETE!" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "Restart OpenCode / terminal and verify with: rtk gain" -ForegroundColor Yellow
