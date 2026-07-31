# Отложенный перезапуск хост-сервера remaude (запускается Планировщиком задач,
# поэтому переживает смерть заказавших его процессов). Логи: ~/.remaude/restart.log
$log = "$env:USERPROFILE\.remaude\restart.log"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content $log }

Log '--- restart begin ---'
Start-Sleep -Seconds 5

# Убиваем текущий листенер порта. Get-NetTCPConnection вместо парсинга netstat —
# прошлая версия на netstat молча не находила процесс в контексте планировщика.
$conns = @(Get-NetTCPConnection -LocalPort 7699 -State Listen -ErrorAction SilentlyContinue)
Log "listeners found: $($conns.Count)"
foreach ($c in $conns) {
  Log "killing pid $($c.OwningProcess)"
  try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { Log "kill failed: $_" }
}

# Ждём освобождения порта (до 10 секунд)
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort 7699 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-NetTCPConnection -LocalPort 7699 -State Listen -ErrorAction SilentlyContinue) {
  Log 'port still busy, aborting'
  exit 1
}

$node = 'C:\Program Files\nodejs\node.exe'
$repo = 'C:\Users\Nidere\Documents\Projects\remaude'
$proc = Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'src\host\server.js' -WorkingDirectory $repo `
  -RedirectStandardOutput "$env:USERPROFILE\.remaude\server.log" `
  -RedirectStandardError "$env:USERPROFILE\.remaude\server.err.log" -PassThru
Log "started new server pid $($proc.Id)"

schtasks /delete /tn remaudeRestart /f 2>$null
Log '--- restart done ---'
