# Starts the productivity-os executor hidden at logon (Windows Task Scheduler), in --watch mode:
# a pass over the action cards every minute, plus the suggestion rules every hour.
# Usage (PowerShell, from the repo folder):
#   powershell -ExecutionPolicy Bypass -File tools\actions\install-executor.ps1            # install + start now
#   powershell -ExecutionPolicy Bypass -File tools\actions\install-executor.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'productivity-os executor'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$name'."
  exit 0
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $repo 'tools\actions\executor.mjs'
$node = (Get-Command node).Source
# conhost --headless runs the console process without a window.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$script`" --watch" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Runs approved productivity-os action cards' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Installed and started '$name' (node: $node)."
Write-Host "Check it with: Get-ScheduledTask -TaskName '$name' | Get-ScheduledTaskInfo"
