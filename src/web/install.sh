#!/bin/bash
# Установщик хоста remaude для macOS.
# Использование: curl -fsSL https://remaude.nidere.com/install.sh | bash
set -euo pipefail

echo "== remaude: установка хоста (macOS) =="
[ "$(uname)" = "Darwin" ] || { echo "Этот установщик — для macOS."; exit 1; }

DIR="$HOME/remaude"
LOG_DIR="$HOME/.remaude"
PLIST="$HOME/Library/LaunchAgents/com.remaude.host.plist"

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "-- Ставлю Node.js через Homebrew…"
    brew install node
  else
    echo "Нужен Node.js: установи LTS с https://nodejs.org и запусти скрипт ещё раз."
    exit 1
  fi
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js устарел (v$NODE_MAJOR), нужен 20+. Обнови с https://nodejs.org"; exit 1; }

# --- Claude Code + логин (нужна своя подписка Claude) ---
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "-- Ставлю Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "-- Входим в Claude (откроется браузер)…"
  claude auth login
fi

# --- Код remaude ---
if [ -d "$DIR/.git" ]; then
  echo "-- Обновляю remaude…"
  git -C "$DIR" pull --ff-only
elif command -v git >/dev/null 2>&1; then
  git clone https://github.com/Nidere/remaude.git "$DIR"
else
  mkdir -p "$DIR"
  curl -fsSL https://github.com/Nidere/remaude/archive/refs/heads/main.tar.gz | tar xz -C "$DIR" --strip-components=1
fi
cd "$DIR"
echo "-- Ставлю зависимости…"
npm install --omit=dev --no-audit --no-fund >/dev/null

# --- launchd: автостарт + автоперезапуск ---
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.remaude.host</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$DIR/src/host/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>REMAUDE_SUPERVISED</key><string>1</string>
  </dict>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2

echo ""
echo "== Готово! Хост remaude запущен и будет стартовать сам при входе в систему. =="
echo "Осталось привязать его к аккаунту:"
echo "  1. Открой https://remaude.nidere.com и войди через Google."
echo "  2. Сайт покажет 6-значный код привязки."
echo "  3. В открывшемся локальном remaude: ⚙ (настройки) → введи код → «Привязать»."
open http://localhost:7699 2>/dev/null || true
