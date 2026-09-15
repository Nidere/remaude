# Starts the remaude host — through Task Scheduler, never as a child of whoever ran this.
#
# A host started straight from a terminal, an IDE or a Claude session is a child of
# that thing and dies with it: twice in one evening it was started from a Claude
# session and vanished within a minute of the tool call ending, without a line in
# the logs. Task Scheduler owns the process instead, and nobody's session can take
# it along. The same task fires every minute as a watchdog: this script is
# idempotent, so a live host costs nothing and a dead one is back within a minute.
#
#   start-host.ps1                    start the host if it is not running (via the task when it exists)
#   start-host.ps1 -Install           register the task: at logon, and every minute after that
#   start-host.ps1 -Install -AtBoot   the same, plus at boot — before anyone logs in
#   start-host.ps1 -Direct            what the task itself runs (via start-host.vbs): spawn node right here
param([switch]$Install, [switch]$Direct, [switch]$AtBoot)

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

  if (-not $AtBoot) {
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings -Force -ErrorAction Stop | Out-Null
    Write-Host "scheduled: '$task' starts the host at logon and checks on it every minute"
    if (-not (Listening)) { Start-ScheduledTask $task }
    return
  }

  # A task registered the plain way runs "only when the user is logged on": after a
  # reboot there is no session for it to run in, so neither the logon trigger nor the
  # minute-by-minute watchdog exists until somebody walks up to the machine and types
  # a password. A stored password buys a batch logon instead — the profile loads, and
  # with it DPAPI and Credential Manager, where gh keeps its GitHub tokens. The host
  # then comes up in session 0 while the logon screen is still showing.
  #
  # The password goes to the Task Scheduler's own credential store and nowhere else:
  # it is never written to disk here and never reaches the repository.
  $triggers = @((New-ScheduledTaskTrigger -AtStartup)) + $triggers
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $secure = Read-Host "Windows password for $user" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not $plain) {
    Write-Error 'an empty password is no good here: Windows refuses batch logon to blank-password accounts, so the task would never run'
    return
  }

  # -Force replaces the task that is working right now, so if the new one turns out
  # to be unusable we put the old arrangement back rather than leave the machine
  # with no watchdog at all.
  function Restore-PlainTask {
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers[1..($triggers.Count - 1)] `
      -Settings $settings -Force | Out-Null
    Write-Host "the previous arrangement is back: '$task' starts the host at logon, as before"
  }

  try {
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings `
      -User $user -Password $plain -RunLevel Limited -Force -ErrorAction Stop | Out-Null
  } catch {
    Write-Error "the scheduler would not take the task with a stored password: $_`nTry the same command from an elevated PowerShell."
    return
  } finally {
    $plain = $null
  }

  # Nobody has checked the password yet — the scheduler stores whatever it is given
  # and only fails at run time, which here would be at the next reboot, with nobody
  # watching. So run the task once now: it is idempotent (a live host costs it
  # nothing), and a password Windows does not accept lands in LastTaskResult as a
  # logon failure — 0x8007052E, which the CIM class may hand back either way round.
  $notRunYet = 267011   # 0x41303, "the task has not yet run"
  $logonFailed = 2147943726, -2147023570
  Start-ScheduledTask $task
  $result = $notRunYet
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Get-ScheduledTask -TaskName $task).State -eq 'Running') { continue }
    $result = (Get-ScheduledTaskInfo $task).LastTaskResult
    if ($result -ne $notRunYet) { break }
  }
  if ($logonFailed -contains $result) {
    Write-Error "Windows did not accept that password: the task cannot log on as $user."
    Restore-PlainTask
    return
  }
  if ($result -eq $notRunYet) { Write-Warning 'the task did not report a result in 15s; check it in Task Scheduler' }

  Write-Host "scheduled: '$task' starts the host at boot, before anyone logs in, and checks on it every minute"
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
