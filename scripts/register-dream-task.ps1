# Register a Windows Task Scheduler job that runs the nightly dream once a day
# through the API-key runner. This is the alternative to the always-on
# graph-dream container (COMPOSE_PROFILES=dream); use one or the other.
#
# Usage, from the folder holding docker-compose.yml and .env:
#   .\scripts\register-dream-task.ps1 -At 22:47
#   .\scripts\register-dream-task.ps1 -Unregister
#
# The task runs `docker compose run --rm graph-dream ...` in that folder, so
# ANTHROPIC_API_KEY_HOST_FILE and the DREAM_* settings come from .env, the same
# as the container. The key stays in its file; this script never reads it.
# Docker Desktop must be running at the scheduled time.

param(
    [string]$At = '22:47',
    [string]$ComposeDir = (Get-Location).Path,
    [string]$TaskName = 'graph-memory nightly dream (API key)',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

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
    -Argument 'compose run --rm graph-dream node dist/dream-runner/index.js' `
    -WorkingDirectory $ComposeDir
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable: if the PC was off or asleep at the set time, run at the
# next chance instead of skipping the night.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Runs prompts/dream-nightly.md on the Anthropic API key (graph-memory dream runner).' -Force | Out-Null

Write-Host "[register-dream-task] '$TaskName' runs daily at $At from $ComposeDir"
Write-Host "[register-dream-task] run it now with: Start-ScheduledTask -TaskName '$TaskName'"
