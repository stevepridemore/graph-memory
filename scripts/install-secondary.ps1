# graph-memory secondary-device installer (PowerShell, for Windows users
# without bash/WSL/Git Bash). Mirrors scripts/install-secondary.sh.
#
# Usage:
#   $v = 'v0.3.0'
#   iwr "https://raw.githubusercontent.com/stevepridemore/graph-memory/$v/scripts/install-secondary.ps1" -UseBasicParsing -OutFile $env:TEMP\gm-install.ps1
#   & $env:TEMP\gm-install.ps1 -Version $v -TunnelHost graph.example.com

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [Parameter(Mandatory=$true)]
    [string]$TunnelHost
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

Write-Host "[install-secondary] graph-memory $Version -> $TunnelHost"

# 1. Slash commands
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
    Write-Host "[install-secondary] installed slash commands to $SkillsDir ($Count skills)"
} else {
    Write-Warning 'skills/ not found in release tarball'
}
Remove-Item $TmpZip
Remove-Item -Recurse $TmpExtract

# 2. MCP client config -- point at the primary's tunnel host
$ClaudeDir = Join-Path $HOME '.claude'
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
$McpJson = Join-Path $ClaudeDir '.mcp.json'
if (Test-Path $McpJson) {
    $Backup = "$McpJson.bak-$(Get-Date -UFormat %s)"
    Copy-Item $McpJson $Backup
    Write-Host "[install-secondary] existing .mcp.json backed up to $Backup"
}
$Template = Invoke-WebRequest "$Raw/.mcp.json.remote.example" -UseBasicParsing
$Body = $Template.Content -replace 'your-host\.example', $TunnelHost
Set-Content -Path $McpJson -Value $Body -Encoding UTF8
Write-Host "[install-secondary] wrote ~/.claude/.mcp.json (HTTP+OAuth -> https://$TunnelHost/mcp)"

Write-Host ''
Write-Host '[install-secondary] done.'
Write-Host ''
Write-Host '  In any Claude Code session, run /graph-stats. The first call will open'
Write-Host '  your browser to complete the OAuth flow with Cloudflare Access. After'
Write-Host '  that, the bearer token is cached and subsequent calls are silent.'
