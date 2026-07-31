#!/bin/bash
# The remaude host installer for macOS.
# It is served by the relay itself, which substitutes its own address for __RELAY_URL__.
set -euo pipefail
RELAY_URL="${REMAUDE_RELAY_URL:-__RELAY_URL__}"

echo "== remaude: host installation (macOS) =="
[ "$(uname)" = "Darwin" ] || { echo "This installer is for macOS."; exit 1; }

DIR="$HOME/remaude"
LOG_DIR="$HOME/.remaude"
PLIST="$HOME/Library/LaunchAgents/com.remaude.host.plist"

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "-- Installing Node.js via Homebrew…"
    brew install node
  else
    echo "Node.js is required: install the LTS from https://nodejs.org and run the script again."
    exit 1
  fi
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js is outdated (v$NODE_MAJOR), 20+ is required. Update it from https://nodejs.org"; exit 1; }

# --- Claude Code + login (you need your own Claude subscription) ---
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "-- Installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "-- Signing in to Claude (a browser will open)…"
  claude auth login
fi

# --- The remaude code ---
if [ -d "$DIR/.git" ]; then
  echo "-- Updating remaude…"
  git -C "$DIR" pull --ff-only
elif command -v git >/dev/null 2>&1; then
  git clone https://github.com/Nidere/remaude.git "$DIR"
else
  mkdir -p "$DIR"
  curl -fsSL https://github.com/Nidere/remaude/archive/refs/heads/main.tar.gz | tar xz -C "$DIR" --strip-components=1
fi
cd "$DIR"
echo "-- Installing dependencies…"
npm install --omit=dev --no-audit --no-fund >/dev/null

# --- launchd: autostart + automatic restart ---
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
    <key>REMAUDE_RELAY_URL</key><string>$RELAY_URL</string>
  </dict>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2

echo ""
echo "== Done! The remaude host is running and will start on its own when you log in. =="
echo "All that is left is to pair it with your account:"
echo "  1. Open $RELAY_URL and sign in with Google."
echo "  2. The site will show a 6-digit pairing code."
echo "  3. In the local remaude that opens: ⚙ (settings) → enter the code → “Pair”."
open http://localhost:7699 2>/dev/null || true
