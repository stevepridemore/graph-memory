# Register a Windows Task Scheduler job that runs the nightly dream (daily) or
# the weekly maintenance (weekly) through the API-key runner. This is the alternative to the always-on
# graph-dream container (COMPOSE_PROFILES=dream); use one or the other.
#
# Usage, from the folder holding docker-compose.yml and .env:
#   .\scripts\register-dream-task.ps1 -At 22:47
#   .\scripts\register-dream-task.ps1 -Job weekly -At 06:00 -DayOfWeek Sunday
#   .\scripts\register-dream-task.ps1 -Unregister           (or -Job weekly -Unregister)
#
# The task runs `docker compose run --rm graph-dream ...` in that folder, so
# ANTHROPIC_API_KEY_HOST_FILE and the DREAM_* settings come from .env, the same
# as the container. The key stays in its file; this script never reads it.
# Docker Desktop must be running at the scheduled time.

param(
    [ValidateSet('nightly', 'weekly')]
    [string]$Job = 'nightly',
    [string]$At = '22:47',
    [string]$DayOfWeek = 'Sunday',
    [string]$ComposeDir = (Get-Location).Path,
    [string]$TaskName = '',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

if (-not $TaskName) {
    $TaskName = if ($Job -eq 'weekly') { 'graph-memory weekly maintenance (API key)' } else { 'graph-memory nightly dream (API key)' }
}

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[register-dream-task] removed '$TaskName'"
    return
}

if (-not (Test-Path (Join-Path $ComposeDir 'docker-compose.yml'))) {
    throw "No docker-compose.yml in $ComposeDir. Run from the graph-memory folder or pass -ComposeDir."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker is not on PATH.'
}

$envFile = Join-Path $ComposeDir '.env'
if (-not (Test-Path $envFile) -or -not (Select-String -Path $envFile -Pattern '^\s*ANTHROPIC_API_KEY_HOST_FILE\s*=' -Quiet)) {
    Write-Warning "ANTHROPIC_API_KEY_HOST_FILE isn't set in $envFile; the run will fail until it is."
}

$docker = (Get-Command docker).Source
$action = New-ScheduledTaskAction -Execute $docker `
    -Argument "compose run --rm graph-dream node dist/dream-runner/index.js --job $Job" `
    -WorkingDirectory $ComposeDir
$trigger = if ($Job -eq 'weekly') {
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $At
} else {
    New-ScheduledTaskTrigger -Daily -At $At
}
# StartWhenAvailable: if the PC was off or asleep at the set time, run at the
# next chance instead of skipping the night.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Runs the graph-memory $Job job on the Anthropic API key (dream runner)." -Force | Out-Null

$when = if ($Job -eq 'weekly') { "every $DayOfWeek at $At" } else { "daily at $At" }
Write-Host "[register-dream-task] '$TaskName' runs $when from $ComposeDir"
Write-Host "[register-dream-task] run it now with: Start-ScheduledTask -TaskName '$TaskName'"
