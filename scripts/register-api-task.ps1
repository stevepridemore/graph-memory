# Register a Windows Task Scheduler job that runs one API task file through the
# general task runner (dist/dream-runner/task.js) on the host, daily or weekly.
# Unlike the dream, these run on the host, not in Docker: they can call local
# tools (python, an MCP server's .exe) that a Linux container can't.
#
# Usage, from the graph-memory folder (after `npm ci && npm run build`):
#   .\scripts\register-api-task.ps1 -TaskFile C:\Users\you\api-tasks\my-task.json -At 08:14
#   .\scripts\register-api-task.ps1 -TaskFile ... -At 06:00 -DayOfWeek Monday -Weekly
#   .\scripts\register-api-task.ps1 -TaskFile ... -Unregister
#
# The API key comes from ANTHROPIC_API_KEY_FILE, set for the task's process
# by this script's -ApiKeyFile (default C:\Users\<you>\claude-api-key). The
# key stays in its file; this script never reads it.

param(
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [string]$At = '08:00',
    [switch]$Weekly,
    [string]$DayOfWeek = 'Monday',
    [string]$RepoDir = (Get-Location).Path,
    [string]$ApiKeyFile = (Join-Path $env:USERPROFILE 'claude-api-key'),
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$name = (Get-Content $TaskFile -Raw | ConvertFrom-Json).name
if (-not $name) { throw "No name in $TaskFile" }
# Task Scheduler rejects ":" in names.
$TaskName = "API task - $name"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[register-api-task] removed '$TaskName'"
    return
}

$runner = Join-Path $RepoDir 'dist\dream-runner\task.js'
if (-not (Test-Path $runner)) { throw "No $runner. Run 'npm ci; npm run build' in $RepoDir first." }
$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $env:USERPROFILE 'graph-memory\logs\dream-runner'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# cmd sets the key-file variable for this one process only, then appends the
# runner's stderr to a log beside its own per-run logs.
$cmdLine = "/c set ""ANTHROPIC_API_KEY_FILE=$ApiKeyFile"" && ""$node"" ""$runner"" ""$TaskFile"" >> ""$logDir\$name.scheduler.log"" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $RepoDir

# Plain local time (no UTC offset baked in), so DST changes keep the wall-clock time.
$time = [datetime]::ParseExact($At, 'HH:mm', $null)
$trigger = if ($Weekly) {
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $time
} else {
    New-ScheduledTaskTrigger -Daily -At $time
}
$trigger.StartBoundary = $time.ToString('yyyy-MM-ddTHH:mm:ss')

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Runs $TaskFile on the Anthropic API key (graph-memory task runner)." -Force -ErrorAction Stop | Out-Null

$when = if ($Weekly) { "every $DayOfWeek at $At" } else { "daily at $At" }
Write-Host "[register-api-task] '$TaskName' runs $when"
Write-Host "[register-api-task] run it now with: Start-ScheduledTask -TaskName '$TaskName'"
