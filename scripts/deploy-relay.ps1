# Деплой relay на инстанс. Все параметры инфраструктуры — в AWS Secrets Manager,
# в репозитории их нет:
#   remaude/google-oauth  {clientId, clientSecret}
#   remaude/relay-deploy  {instanceIp, domain, whitelist, contactEmail, sshKeyPath}
$ErrorActionPreference = 'Stop'
$region = if ($env:REMAUDE_AWS_REGION) { $env:REMAUDE_AWS_REGION } else { 'eu-central-1' }

function Get-Secret($id) {
  (aws secretsmanager get-secret-value --secret-id $id --region $region | ConvertFrom-Json).SecretString | ConvertFrom-Json
}

$oauth = Get-Secret 'remaude/google-oauth'
$cfg = Get-Secret 'remaude/relay-deploy'

$pem = $cfg.sshKeyPath -replace '^~', $env:USERPROFILE
$target = "ubuntu@$($cfg.instanceIp)"
$sshOpts = @('-i', $pem, '-o', 'StrictHostKeyChecking=accept-new')
$repo = Split-Path $PSScriptRoot -Parent

# 1. окружение сервиса
$envContent = @(
  "GOOGLE_CLIENT_ID=$($oauth.clientId)"
  "GOOGLE_CLIENT_SECRET=$($oauth.clientSecret)"
  "WHITELIST=$($cfg.whitelist)"
  "BASE_URL=https://$($cfg.domain)"
  "CONTACT_EMAIL=$($cfg.contactEmail)"
  'PORT=8080'
  'STATE_PATH=/opt/remaude/relay-state.json'
) -join "`n"
$tmpEnv = "$env:TEMP\remaude-relay.env"
[IO.File]::WriteAllText($tmpEnv, $envContent + "`n", [Text.UTF8Encoding]::new($false))

# 2. код на сервер. package.json у relay свой, минимальный: корневой тянет весь
# Agent SDK, который на nano-инстансе не нужен и не влезает по памяти.
$relayPkg = '{"name":"remaude-relay","private":true,"type":"module","dependencies":{"ws":"^8.21.1","web-push":"^3.6.7"}}'
$tmpPkg = "$env:TEMP\remaude-relay-pkg.json"
[IO.File]::WriteAllText($tmpPkg, $relayPkg, [Text.UTF8Encoding]::new($false))
ssh @sshOpts $target 'mkdir -p /opt/remaude/src'
scp @sshOpts -r "$repo\src\relay" "$repo\src\web" "${target}:/opt/remaude/src/"
scp @sshOpts $tmpPkg "${target}:/opt/remaude/package.json"
scp @sshOpts $tmpEnv "${target}:/opt/remaude/.env"
Remove-Item $tmpEnv, $tmpPkg -Force

# 3. зависимости + systemd + caddy
$remote = @"
set -e
cd /opt/remaude
rm -rf node_modules package-lock.json
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1
chmod 600 .env
sudo tee /etc/systemd/system/remaude-relay.service > /dev/null <<'UNIT'
[Unit]
Description=remaude relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/remaude/src/relay/relay.js
EnvironmentFile=/opt/remaude/.env
Restart=always
RestartSec=3
User=ubuntu

[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/caddy/Caddyfile > /dev/null <<'CADDY'
$($cfg.domain) {
    reverse_proxy 127.0.0.1:8080
}
CADDY
sudo systemctl daemon-reload
sudo systemctl enable --now remaude-relay
sudo systemctl restart remaude-relay caddy
sleep 2
systemctl is-active remaude-relay caddy
"@
$remote = $remote -replace "`r`n", "`n"
$tmpSh = "$env:TEMP\remaude-deploy.sh"
[IO.File]::WriteAllText($tmpSh, $remote, [Text.UTF8Encoding]::new($false))
scp @sshOpts $tmpSh "${target}:/tmp/deploy.sh"
Remove-Item $tmpSh -Force
ssh @sshOpts $target 'bash /tmp/deploy.sh && rm /tmp/deploy.sh'
Write-Host 'deploy done'
