# remaude: deploying your own instance

Written for the Claude Code instance that will set this up for a new owner.
Read it through before starting: several places look obvious but are not, and
those are marked ⚠.

## What this is and what it consists of

remaude is a web shell for Claude Code: a browser interface instead of many
VS Code windows, reachable from outside (phone, another computer).

Three parts:

```
Browser (desktop / phone, PWA)
        │ HTTPS/WSS
        ▼
Relay (small VPS + Caddy)          ← auth, routing; stores no content
        ▲ outbound WSS
        │
Host agent (owner's machine)       ← Agent SDK, files, Claude Code sessions
```

- **Host agent** (`src/host/`) — a Node process on the machine where Claude Code
  runs. It keeps live SDK sessions, serves the web UI on `127.0.0.1:7699`, and
  dials out to the relay. All data (projects, transcripts, tokens) stays here.
- **Relay** (`src/relay/`) — runs on a VPS behind a public domain. It gates
  access with Google OAuth (strict allowlist), connects browsers to hosts and
  sends push notifications. Transcripts pass through but are never stored.
- **Web UI** (`src/web/`) — static files, identical locally and through the relay.

The key idea: **the host connects to the relay itself, outbound**. No port
forwarding, no static IP, no DDNS — it works behind any NAT.

## What the owner needs

1. Their own Claude subscription (Pro/Max) — remaude neither replaces nor shares it.
2. A domain they control (an A record is required).
3. An AWS account, or any VPS provider; the walkthrough below uses AWS Lightsail (~$5/month).
4. A Google Cloud project for the OAuth client (free).
5. The list of emails allowed to sign in (usually one to three).

## Deployment order

### 1. Host locally (5 minutes, immediate feedback)

```bash
git clone <repository> remaude && cd remaude
npm install
npm start                     # → http://localhost:7699
```

Open it and click "add project". Once that works, move on to the relay —
everything else (remote access, sharing, push) is a layer on top.

⚠ Node 20+ is required. Claude Code must be installed and signed in
(`claude auth status` reports `"loggedIn": true`) because the SDK spawns it as a
subprocess. If it is not, that can be done from the UI: ⚙ → "sign in to Claude".

### 2. Google OAuth client

Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID →
type **Web application**:

- Authorized JavaScript origins: `https://<domain>`
- Authorized redirect URIs: `https://<domain>/auth/google/callback`

Every deployment needs **its own** OAuth client — nothing is shared between
installations. The relay never hardcodes any of this: the id and secret come
from the environment, and the redirect URI is derived from `BASE_URL`.

Keep the client ID and secret. ⚠ Never commit the secret: it belongs in AWS
Secrets Manager (below) or in environment variables on the server.

⚠ Two traps that account for most "OAuth suddenly broke" reports:

- **The redirect URI must match `BASE_URL` character for character.** A stray
  `www`, `http` instead of `https`, or a trailing slash gets you
  `redirect_uri_mismatch` and nothing else explains why.
- **While the consent screen is in "Testing" status**, only accounts listed as
  test users in the console can sign in, and everyone sees an "unverified app"
  warning. For a handful of private users that is fine — publishing and
  verification are not needed — but forgetting to add yourself as a test user
  locks you out. The seven-day refresh token limit of Testing mode does not
  apply here: the code is exchanged once for an `id_token` to read the verified
  email, after which sessions ride on the relay's own signed cookie.

### 3. VPS and DNS

Lightsail example (AWS CLI already configured):

```bash
aws lightsail create-key-pair --key-pair-name remaude --region <region>
# save privateKeyBase64 from the response as ~/.remaude/lightsail-remaude.pem

aws lightsail create-instances --instance-names remaude-relay \
  --availability-zone <zone> --blueprint-id ubuntu_24_04 --bundle-id nano_3_0 \
  --key-pair-name remaude --region <region> --user-data file://provision.sh

aws lightsail allocate-static-ip --static-ip-name remaude-ip --region <region>
aws lightsail attach-static-ip --static-ip-name remaude-ip \
  --instance-name remaude-relay --region <region>

aws lightsail put-instance-public-ports --instance-name remaude-relay --region <region> \
  --port-infos '[{"fromPort":22,"toPort":22,"protocol":"tcp"},{"fromPort":80,"toPort":80,"protocol":"tcp"},{"fromPort":443,"toPort":443,"protocol":"tcp"}]'
```

`provision.sh` (user data) installs Node 22 and Caddy:

```bash
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
mkdir -p /opt/remaude && chown ubuntu:ubuntu /opt/remaude
```

⚠ Traps already hit here:

- `--user-data file://...` needs a **plain ASCII file with LF endings**. The
  UTF-16/BOM/CRLF output PowerShell produces by default is silently rejected.
- Do not pass a multi-line script as an inline argument — PowerShell 5.1 splits
  it on whitespace and the command fails in confusing ways.

Then point an A record at the static IP. Caddy fetches a Let's Encrypt
certificate on its own once DNS propagates.

### 4. Secrets and relay deployment

`scripts/deploy-relay.ps1` (Windows) reads two secrets from AWS Secrets Manager,
which is why no domains, IPs or emails live in the repository:

```
remaude/google-oauth   {"clientId":"…","clientSecret":"…"}
remaude/relay-deploy   {"instanceIp":"…","domain":"…","whitelist":"a@b.com,c@d.com",
                        "contactEmail":"…","sshKeyPath":"~/.remaude/…pem"}
```

Create them:

```bash
aws secretsmanager create-secret --name remaude/google-oauth --region <region> \
  --secret-string file://oauth.json
aws secretsmanager create-secret --name remaude/relay-deploy --region <region> \
  --secret-string file://relay.json
```

⚠ The secret must be **valid JSON**. A PowerShell hashtable stringified inline
yields `{clientId:…}` without quotes, which fails to parse later.

Then simply:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-relay.ps1
```

The script copies `src/relay` and `src/web`, installs dependencies, writes
`/opt/remaude/.env`, a `remaude-relay` systemd unit and a Caddyfile, then
restarts both services.

⚠ The relay gets its **own minimal package.json** (only `ws` and `web-push`).
The root one pulls in the Agent SDK, and on a 512 MB instance `npm install`
takes the machine down hard enough to drop SSH — recovery needs an API reboot.

If you are not on Windows, rewrite the script in bash; the logic is trivial:
assemble `.env`, copy two directories, `npm install --omit=dev`, systemd + Caddy.

### 5. First sign-in and host pairing

1. Open `https://<domain>` → "sign in with Google" (an allowlisted account).
2. The site shows a six-digit code because no host is connected yet.
3. In the local UI (`localhost:7699`): ⚙ → relay address and code → "pair".
4. Reload the domain — the full interface is there.

On a phone: open the domain, "Add to Home Screen" (PWA), then enable
notifications in ⚙.

### 6. Onboarding other users (macOS)

`https://<domain>/install.sh` is served by the relay with its own address
substituted in, so a new user only runs:

```bash
curl -fsSL https://<domain>/install.sh | bash
```

The script installs Node (via Homebrew), installs and signs into Claude Code,
clones the repository, registers a launchd agent with autostart and opens the
local UI. Then follow step 5.

⚠ They must be on the relay's allowlist, otherwise Google sign-in ends at the
"not allowed" page. The allowlist lives in the `remaude/relay-deploy` secret and
takes effect after a redeploy.

## Access model (understand this before changing anything)

Three independent locks:

1. **Account** — Google OAuth plus the allowlist. Not listed, not admitted.
2. **Device** — trusted permanently (signed cookie, two years) when it either
   arrives from the same public IP as the owner's host (i.e. from home), or the
   account has no hosts yet (onboarding), or a one-time code from the site is
   entered in the settings of an already trusted device.
3. **Host** — bound to an account by the token issued during pairing.

Guests (chat sharing) never get host access as such: the relay admits them into
the owner's tunnel with a list of allowed session ids, and the host filters both
state and commands, leaving them only reading and sending messages.

⚠ When touching `readDevice`/`sameNetworkAsHost`, remember that X-Forwarded-For
is trusted only when the socket comes from loopback (i.e. from Caddy), and that
loopback itself never counts as "the same network" — otherwise a missing header
would silently trust everyone.

## Internals

### Host (`src/host/`)

| File | Responsibility |
|---|---|
| `chat.js` | One SDK session: input queue, statuses, permissions, limits, effort/model |
| `agent.js` | Projects (directories) → chats, outbound events |
| `server.js` | HTTP + WS protocol, config, sharing, relay tunnel, Claude sign-in |
| `transcripts.js` | Reads `~/.claude/projects/**/*.jsonl` for history and session lists |
| `relay-link.js` | Outbound relay connection, client tunnelling |
| `usage.js` | Adapter for the limits widget data |

Decisions worth preserving:

- **A chat is a live Agent SDK session in streaming-input mode.** `query()`
  receives an async iterator that stays open between turns, which is what allows
  messaging the model mid-run. Closing the iterator ends the session.
- **History is not replayed on `resume`.** The SDK restores context but sends no
  past messages, so the transcript is rebuilt from JSONL. That format is
  undocumented, hence best-effort parsing that skips unknown records. ⚠ Records
  carrying `origin.kind` are harness injections and must be skipped, or they
  render as user messages.
- **The limits widget** reads
  `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` — an
  officially unstable method, isolated in `usage.js`. If it breaks, fix it there;
  the fallback (the undocumented `api.anthropic.com/api/oauth/usage`) is
  aggressively rate-limited.
- **Open chats survive restarts**: the list (project + sessionId + mode) lives in
  `~/.remaude/host.json` and is resumed on startup.
- **Self-restart** (`restart_server`): the process spawns a detached copy of
  itself and exits, and the copy waits for the port to free up. ⚠ The `listen`
  retry does not work without an `error` handler on the `WebSocketServer`: the
  `ws` library re-emits http server errors onto itself and the process dies
  before the retry runs. Under a supervisor (launchd/systemd, with
  `REMAUDE_SUPERVISED=1`) exiting is enough.
- **`AskUserQuestion` is denied** in `canUseTool`: there are no interactive
  questionnaires in the web UI, so the model is told to ask in plain text
  instead. That hook fires even in bypass mode.

### Relay (`src/relay/`)

A single file with no database: state (cookie secret, VAPID keys, host tokens,
push subscriptions) lives in `/opt/remaude/relay-state.json`.

- `/auth/google*` — OAuth, verification of `aud` and `email_verified`, allowlist, cookie.
- `/pair` — exchanges a pairing code for a host token.
- `/ws` — browsers (both the session and device cookies are required).
- `/host` — hosts (by token); tunnel messages `{t:'open'|'msg'|'close'|'cast'|'push'|'shares'}`.
- `/api/push/*` — VAPID key and subscriptions.

⚠ `relay-state.json` is not backed up. Losing it means re-pairing every host and
device (chat data is unaffected — it lives on the hosts). If that matters, add a
copy to S3.

### Web UI (`src/web/`)

Vanilla JS with no build step — edit a file, reload the page. `app.js` is a thin
WS protocol client: transcript rendering (stream deltas, collapsed tool calls,
subagents), sidebar, permissions, settings. `md.js` is a minimal markdown
renderer that escapes HTML first and only then adds markup — important, because
tool output ends up in the transcript.

⚠ Mobile traps already paid for: `viewport-fit=cover` pushes the interface under
the notch and is not needed; `position: fixed` on `body` is required or iOS drags
the whole app with rubber-banding; `@media (hover: none)` rules must sit **at the
end of the file**, otherwise they lose on source order and the buttons vanish on
touch devices.

## Debugging

```bash
# host
~/.remaude/server.log, server.err.log
# relay
ssh -i <pem> ubuntu@<ip> 'journalctl -u remaude-relay -n 50 --no-pager'
ssh -i <pem> ubuntu@<ip> 'systemctl is-active remaude-relay caddy'
```

`experiments/` holds standalone probes: `test-image.mjs` (image input),
`test-usage.mjs` (limits), `test-resume.mjs` (session resuming),
`test-ws-client.mjs` (end-to-end protocol run), `ui-mobile.mjs` (layout
screenshots), `test-restart.mjs` (self-restart cycle). They are executable
documentation — when in doubt, run the relevant one instead of guessing.

## Deliberately absent

Diff viewers and a code editor (VS Code remains the editor), a multi-host
switcher, LAN mode without the relay, single-file binaries (installer plus
launchd for now), relay state backups, session cookie rotation, and access
revocation from the UI.
