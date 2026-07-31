# A delayed restart of the host from outside (for example, through Task Scheduler), when
# self-restart from the UI is unavailable. Logs: ~/.remaude/restart.log
$log = "$env:USERPROFILE\.remaude\restart.log"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content $log }

$port = if ($env:REMAUDE_PORT) { [int]$env:REMAUDE_PORT } else { 7699 }
Log '--- restart begin ---'
Start-Sleep -Seconds 5

# Kill the current listener on the port (natively: parsing netstat under Task Scheduler lied)
$conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
Log "listeners found: $($conns.Count)"
foreach ($c in $conns) {
  Log "killing pid $($c.OwningProcess)"
  try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { Log "kill failed: $_" }
}

for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Log 'port still busy, aborting'
  exit 1
}

& "$PSScriptRoot\start-host.ps1"
Log '--- restart done ---'
