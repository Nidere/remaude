# Отложенный перезапуск хост-сервера remaude.
# Запускается через Планировщик задач (detached), поэтому переживает смерть
# процессов, которые его заказали. Новый сервер — скрытый фоновый node,
# логи в ~/.remaude/server.log.
Start-Sleep -Seconds 5

$listeners = netstat -ano | Select-String ':7699' | Select-String 'LISTENING'
foreach ($line in $listeners) {
  $procId = ($line -split '\s+')[-1]
  if ($procId -match '^\d+$') { taskkill /f /pid $procId }
}
Start-Sleep -Seconds 1

$node = 'C:\Program Files\nodejs\node.exe'
$repo = 'C:\Users\Nidere\Documents\Projects\remaude'
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'src\host\server.js' -WorkingDirectory $repo `
  -RedirectStandardOutput "$env:USERPROFILE\.remaude\server.log" `
  -RedirectStandardError "$env:USERPROFILE\.remaude\server.err.log"

schtasks /delete /tn remaudeRestart /f 2>$null
