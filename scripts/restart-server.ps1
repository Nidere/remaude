# Отложенный перезапуск хоста извне (например, через Планировщик), когда
# самоперезапуск из UI недоступен. Логи: ~/.remaude/restart.log
$log = "$env:USERPROFILE\.remaude\restart.log"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content $log }

$port = if ($env:REMAUDE_PORT) { [int]$env:REMAUDE_PORT } else { 7699 }
Log '--- restart begin ---'
Start-Sleep -Seconds 5

# Убиваем текущий листенер порта (нативно: парсинг netstat под Планировщиком врал)
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
