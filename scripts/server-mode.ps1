# Turns this computer into a server: the host moves out of the desktop session, and
# then the desktop session ends. What is left is a machine with nobody logged into
# it that still answers through the relay from anywhere. Logs: ~/.remaude/server-mode.log
#
# The ⚙ Restart server button cannot do this — it spawns a copy of the host and
# exits, and the copy inherits the session it was spawned from. Only a start that
# comes from the scheduled task gets a batch logon, and only a task with a stored
# password can do that with nobody logged in. Hence both checks below.
#
# The host reaches this script through server-mode.vbs, never directly — see the
# comment there, it is a trap that costs an afternoon to find.
#
# The order is the whole point. Signing out first would take the host down with the
# session and leave the machine unreachable until somebody walks up to it, so we
# sign out only after seeing a listener that belongs to session 0.
$log = "$env:USERPROFILE\.remaude\server-mode.log"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $log }

# wscript throws away whatever we print, so anything that goes wrong has to put
# itself in the log or it never happened as far as anyone can tell.
trap { Log "unhandled: $_"; exit 1 }

$task = 'remaude host'
$port = if ($env:REMAUDE_PORT) { [int]$env:REMAUDE_PORT } else { 7699 }
Log '--- server mode requested ---'

if ((Get-Process -Id $PID).SessionId -eq 0) {
  Log 'already outside a desktop session, nothing to do'
  exit 0
}

$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if (-not $t) {
  Log "no '$task' task: nothing would bring the host back. Run start-host.ps1 -Install -AtBoot"
  exit 1
}
if ($t.Principal.LogonType -ne 'Password') {
  Log "the '$task' task runs only while someone is logged on. Run start-host.ps1 -Install -AtBoot"
  exit 1
}

# Kills the host and hands the restart to the task, which is what puts the new one
# in session 0. We are a detached process, so dying with it is not our problem.
& "$PSScriptRoot\restart-server.ps1"

$deadline = (Get-Date).AddMinutes(2)
$ready = $false
$notedPid = 0
while ((Get-Date) -lt $deadline) {
  $conn = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)[0]
  if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc.SessionId -eq 0) { $ready = $true; break }
    # Not ours to fix: the watchdog fires every minute and will replace it through
    # the task. Noted once per pid so a two-minute wait is not a wall of log.
    if ($proc -and $proc.Id -ne $notedPid) {
      $notedPid = $proc.Id
      Log "listener pid $($proc.Id) is in session $($proc.SessionId), not 0: waiting"
    }
  }
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  Log 'gave up waiting for a host in session 0: staying signed in, remaude is still up'
  exit 1
}

Log 'the host is in session 0: signing out'
shutdown.exe /l
