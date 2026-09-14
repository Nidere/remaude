# Starts the remaude host — through Task Scheduler, never as a child of whoever ran this.
#
# A host started straight from a terminal, an IDE or a Claude session is a child of
# that thing and dies with it: twice in one evening it was started from a Claude
# session and vanished within a minute of the tool call ending, without a line in
# the logs. Task Scheduler owns the process instead, and nobody's session can take
# it along. The same task fires every minute as a watchdog: this script is
# idempotent, so a live host costs nothing and a dead one is back within a minute.
#
#   start-host.ps1            start the host if it is not running (via the task when it exists)
#   start-host.ps1 -Install   register the task: at logon, and every minute after that
#   start-host.ps1 -Direct    what the task itself runs (via start-host.vbs): spawn node right here
param([switch]$Install, [switch]$Direct)

$task = 'remaude host'
$port = if ($env:REMAUDE_PORT) { [int]$env:REMAUDE_PORT } else { 7699 }
$repo = Split-Path $PSScriptRoot -Parent
$logDir = "$env:USERPROFILE\.remaude"
New-Item -ItemType Directory -Force $logDir | Out-Null

function Listening { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

if ($Install) {
  # through wscript: powershell.exe started by the scheduler flashes a console window, wscript does not
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "//B //Nologo `"$PSScriptRoot\start-host.vbs`""
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1))
  )
  # the laptop on battery is still the laptop the sessions live on
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Host "scheduled: '$task' starts the host at logon and checks on it every minute"
  if (-not (Listening)) { Start-ScheduledTask $task }
  return
}

if (Listening) { exit 0 }

if (-not $Direct) {
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Start-ScheduledTask $task; exit 0 }
  Write-Warning "no '$task' task: the host will be a child of this shell and die with it. Run start-host.ps1 -Install."
}

# The watchdog found it dead: the minute it noticed is the best clue to what killed it.
if ($Direct) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') host not listening, starting it" | Add-Content "$logDir\watchdog.log" }

# The logs are rewritten on every start; the previous run's are where the crash is.
foreach ($name in 'server.log', 'server.err.log') {
  if (Test-Path "$logDir\$name") { Move-Item -Force "$logDir\$name" "$logDir\$($name -replace '\.log$', '.prev.log')" }
}
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'src\host\server.js' -WorkingDirectory $repo `
  -RedirectStandardOutput "$logDir\server.log" -RedirectStandardError "$logDir\server.err.log"
