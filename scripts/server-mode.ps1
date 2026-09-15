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

# Every desktop session on the machine, whoever it belongs to. explorer.exe is the
# marker: a batch logon has none, and a person sitting down at the machine has
# exactly one. Asking this way rather than parsing `query session` also answers it
# from session 0, where the script runs when the host is already out of the way and
# all that is left to do is end whatever somebody logged in with since.
function DesktopSessions {
  @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
      ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).SessionId } |
      Sort-Object -Unique)
}

if ((Get-Process -Id $PID).SessionId -eq 0) {
  Log 'the host is already outside a desktop session'
} else {
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
}

# shutdown.exe /l was the obvious way and it did nothing at all: no error anyone
# could see, and no 4647 in the security log to say a logoff was ever asked for. It
# goes through ExitWindowsEx, which wants an interactive window station, and there
# is none worth speaking of behind a lock screen in a disconnected RDP session.
# logoff.exe names the session outright and ends it through the terminal-services
# API, which is the one that does not care whether anybody is looking.
#
# Whatever is listening on the port is the host we just made, and its session is the
# one that must survive this. It is session 0 and has no explorer.exe, so it would
# not be in the list anyway - but this is too important to leave to that. Ours goes
# last, because signing it out kills this script where it stands.
$hostSession = (Get-Process -Id @(Get-NetTCPConnection -LocalPort $port -State Listen)[0].OwningProcess).SessionId
$mine = (Get-Process -Id $PID).SessionId
$sessions = @(DesktopSessions | Where-Object { $_ -ne $hostSession } | Sort-Object { $_ -eq $mine })
if (-not $sessions) {
  Log 'no desktop session left to sign out of: this machine is a server now'
  exit 0
}
Log "the host is in session ${hostSession}; signing out of: $($sessions -join ', ')"
foreach ($s in $sessions) {
  # Said before doing it: signing out our own session kills this script mid-line,
  # and a log that ends here means it worked.
  Log "signing out of session ${s}"
  $out = (& logoff.exe $s 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE

  # A session with a browser and a WSL in it does not go quietly: sixty-odd
  # processes have to be torn down, and the first version of this called that a
  # failure five seconds in and wrote it down as one.
  $gone = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (-not @(Get-Process | Where-Object { $_.SessionId -eq $s })) { $gone = $true; break }
    Start-Sleep -Seconds 2
  }
  if ($gone) { Log "session $s is gone" }
  else { Log "session $s is still here a minute after logoff (exit $code) $out" }
}
