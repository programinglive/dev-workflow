# ==============================================================================
# Programinglive Homelab Bootstrap Script for Windows (HELLOWORLD)
# Installs: RTK (Token Killer), Superpowers (Skills), and Dev-Workflow MCP
# ==============================================================================

Write-Host "🚀 Starting Homelab Windows Bootstrap on HELLOWORLD..." -ForegroundColor Cyan

# 1. Check / Install RTK
if (!(Get-Command rtk -ErrorAction SilentlyContinue)) {
    Write-Host "⚡ Installing RTK via winget..." -ForegroundColor Yellow
    winget install rtk-ai.rtk --accept-source-agreements --accept-package-agreements
} else {
    Write-Host "✓ RTK is already installed." -ForegroundColor Green
}

# 2. Setup OpenCode Config Directory
$configDir = "$env:APPDATA\opencode"
$pluginsDir = "$configDir\plugins"
$nodeModulesDir = "$configDir\node_modules"
$superpowersDir = "$nodeModulesDir\superpowers"

if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
if (!(Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }
if (!(Test-Path $nodeModulesDir)) { New-Item -ItemType Directory -Path $nodeModulesDir | Out-Null }

# 3. Clone / Update Superpowers
if (Test-Path $superpowersDir) {
    Write-Host "📦 Updating Superpowers..." -ForegroundColor Yellow
    git -C $superpowersDir pull --depth 1
} else {
    Write-Host "📦 Cloning Superpowers..." -ForegroundColor Yellow
    git clone --depth 1 https://github.com/obra/superpowers.git $superpowersDir
}

# 4. Clone or Setup Dev-Workflow MCP Server
$serverDir = "$HOME\Documents\dev-workflow-mcp-server"
if (!(Test-Path $serverDir)) {
    Write-Host "🛠️ Cloning dev-workflow-mcp-server..." -ForegroundColor Yellow
    git clone https://github.com/programinglive/dev-workflow-mcp-server.git $serverDir
} else {
    Write-Host "✓ dev-workflow-mcp-server already exists at $serverDir" -ForegroundColor Green
}

# 5. Configure opencode.json
$opencodeJsonPath = "$configDir\opencode.json"
$config = @{}
if (Test-Path $opencodeJsonPath) {
    try {
        $jsonContent = Get-Content $opencodeJsonPath -Raw | Out-String
        $config = $jsonContent | ConvertFrom-Json -AsHashtable
    } catch {
        Write-Host "⚠️ Existing opencode.json couldn't be parsed, creating new." -ForegroundColor Yellow
    }
}

if (-not $config['$schema']) { $config['$schema'] = "https://opencode.ai/config.json" }
if (-not $config['plugin']) { $config['plugin'] = @() }
if ($config['plugin'] -notcontains "superpowers@git+https://github.com/obra/superpowers.git") {
    $config['plugin'] += "superpowers@git+https://github.com/obra/superpowers.git"
}

if (-not $config['mcp']) { $config['mcp'] = @{} }
$serverIndexPath = "$serverDir\index.js"
$config['mcp']['dev-workflow'] = @{
    type = "local"
    command = @("node", $serverIndexPath)
    enabled = $true
}

$config | ConvertTo-Json -Depth 10 | Set-Content $opencodeJsonPath -Encoding UTF8
Write-Host "✓ opencode.json configured successfully." -ForegroundColor Green

# 6. Register RTK hook
& rtk init -g --opencode

Write-Host "`n=============================================================" -ForegroundColor Cyan
Write-Host "🎉 HELLOWORLD HOMELAB BOOTSTRAP COMPLETE!" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "Restart OpenCode / terminal and verify with: rtk gain" -ForegroundColor Yellow
