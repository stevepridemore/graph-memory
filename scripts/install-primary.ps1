# graph-memory primary-device installer (PowerShell, for Windows users
# without bash/WSL/Git Bash). Mirrors scripts/install-primary.sh.
#
# Usage:
#   iwr -UseBasicParsing https://raw.githubusercontent.com/stevepridemore/graph-memory/v0.3.0/scripts/install-primary.ps1 `
#     | iex
#   ...wait, that pattern only works without arguments. For tagged installs:
#
#   $v = 'v0.3.0'
#   iwr "https://raw.githubusercontent.com/stevepridemore/graph-memory/$v/scripts/install-primary.ps1" -UseBasicParsing -OutFile $env:TEMP\gm-install.ps1
#   & $env:TEMP\gm-install.ps1 -Version $v

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$Repo = 'stevepridemore/graph-memory'
$Raw = "https://raw.githubusercontent.com/$Repo/$Version"
if ($Version -eq 'latest') {
    $Tarball = "https://github.com/$Repo/archive/refs/heads/main.zip"
    $TarballPrefix = 'graph-memory-main'
} else {
    $Tarball = "https://github.com/$Repo/archive/refs/tags/$Version.zip"
    $TarballPrefix = "graph-memory-$($Version.TrimStart('v'))"
}

Write-Host "[install-primary] graph-memory $Version"

# 0. Pre-flight: Docker must be installed and the daemon must be running.
#    Without it, `docker compose up` later will fail with a less helpful error.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '[install-primary] ERROR: docker is not installed on this device.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  graph-memory runs Neo4j + the MCP server as Docker containers.'
    Write-Host '  Install Docker Desktop for Windows from:'
    Write-Host '    https://www.docker.com/products/docker-desktop/'
    Write-Host '  Then re-run this installer.'
    exit 1
}

# `docker info` exits non-zero (and writes to stderr) when the daemon is down,
# even if the CLI is installed. Suppress stderr noise; check exit code only.
$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '[install-primary] ERROR: Docker is installed but the daemon is not running.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Start Docker Desktop and wait for the "Docker Desktop is running"'
    Write-Host '  notification, then re-run this installer.'
    exit 1
}
Write-Host '[install-primary] docker: OK'

# 1. Data directory + compose + env template
$DataDir = Join-Path $HOME 'graph-memory'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Write-Host "[install-primary] data dir: $DataDir"

Invoke-WebRequest "$Raw/docker-compose.yml" -OutFile (Join-Path $DataDir 'docker-compose.yml') -UseBasicParsing
Write-Host "[install-primary] wrote docker-compose.yml"

$EnvPath = Join-Path $DataDir '.env'
if (-not (Test-Path $EnvPath)) {
    Invoke-WebRequest "$Raw/.env.example" -OutFile $EnvPath -UseBasicParsing
    Write-Host "[install-primary] wrote .env (TEMPLATE -- edit before starting)"
} else {
    Write-Host "[install-primary] kept existing .env"
}

# 2. Slash commands -- extract skills/ from the release zip into ~/.claude/skills/
$SkillsDir = Join-Path $HOME '.claude\skills'
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
$TmpZip = Join-Path $env:TEMP "graph-memory-$Version.zip"
$TmpExtract = Join-Path $env:TEMP "graph-memory-$Version-extract"
Invoke-WebRequest $Tarball -OutFile $TmpZip -UseBasicParsing
if (Test-Path $TmpExtract) { Remove-Item -Recurse -Force $TmpExtract }
Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract -Force
$SrcSkills = Join-Path $TmpExtract "$TarballPrefix\skills"
if (Test-Path $SrcSkills) {
    Copy-Item -Recurse -Force -Path (Join-Path $SrcSkills '*') -Destination $SkillsDir
    $Count = (Get-ChildItem $SrcSkills -Directory).Count
    Write-Host "[install-primary] installed slash commands to $SkillsDir ($Count skills)"
} else {
    Write-Warning "skills/ not found in release tarball; skipping slash commands"
}
Remove-Item $TmpZip
Remove-Item -Recurse $TmpExtract

# 3. MCP client config (stdio mode talking to the local docker container)
$ClaudeDir = Join-Path $HOME '.claude'
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
$McpJson = Join-Path $ClaudeDir '.mcp.json'
if (-not (Test-Path $McpJson)) {
    Invoke-WebRequest "$Raw/.mcp.json.example" -OutFile $McpJson -UseBasicParsing
    Write-Host "[install-primary] wrote ~/.claude/.mcp.json"
} else {
    Write-Host "[install-primary] kept existing ~/.claude/.mcp.json"
}

Write-Host ''
Write-Host '[install-primary] next steps:'
Write-Host ''
Write-Host "  1. Edit ${EnvPath}:"
Write-Host '       - NEO4J_PASSWORD (>=8 chars)'
Write-Host "       - GRAPH_MEMORY_HOME=$DataDir"
Write-Host "       - CLAUDE_PROJECTS_DIR=$(Join-Path $HOME '.claude\projects')"
Write-Host ''
Write-Host '  2. Start the containers:'
Write-Host "       cd $DataDir; docker compose up -d"
Write-Host ''
Write-Host '  3. (Optional) Install scheduled tasks:'
Write-Host '       docker exec graph-memory-mcp python3 /app/scripts/sync-dream-skill.py `'
Write-Host "         --user-home '$HOME' --prompts-dir /root/graph-memory/prompts --os windows"
Write-Host ''
Write-Host '  4. In any Claude Code session, run /graph-stats to verify.'
Write-Host ''
Write-Host '  For multi-device access (claude.ai web, secondary laptops): see docs/REMOTE.md'
Write-Host '  for the optional Cloudflare Tunnel setup. Without it, this install is'
Write-Host '  local-only -- accessible only from this device.'
