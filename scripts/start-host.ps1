# Автостарт хоста remaude (задача Планировщика «при логине»).
# Идемпотентен: если порт уже занят живым сервером — тихо выходим.
$port = if ($env:REMAUDE_PORT) { [int]$env:REMAUDE_PORT } else { 7699 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { exit 0 }

$repo = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force "$env:USERPROFILE\.remaude" | Out-Null
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'src\host\server.js' -WorkingDirectory $repo `
  -RedirectStandardOutput "$env:USERPROFILE\.remaude\server.log" `
  -RedirectStandardError "$env:USERPROFILE\.remaude\server.err.log"
