# Автостарт хоста remaude (задача Планировщика «при логине»).
# Идемпотентен: если порт уже занят живым сервером — тихо выходим.
$conn = Get-NetTCPConnection -LocalPort 7699 -State Listen -ErrorAction SilentlyContinue
if ($conn) { exit 0 }

New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src\host\server.js' `
  -WorkingDirectory 'C:\Users\Nidere\Documents\Projects\remaude' `
  -RedirectStandardOutput "$env:USERPROFILE\.remaude\server.log" `
  -RedirectStandardError "$env:USERPROFILE\.remaude\server.err.log"
