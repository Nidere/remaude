// remaude relay: the public entry point (the domain is set via BASE_URL).
// Browsers: web UI static files + Google OAuth (whitelist) + WSS /ws.
// Hosts: outbound WSS /host?token=… ; pairing: POST /pair {code}.
// Chat content is not stored — only routing and bookkeeping of host tokens.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';

const PORT = Number(process.env.PORT ?? 8080);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const WHITELIST = (process.env.WHITELIST ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const STATE_PATH = process.env.STATE_PATH ?? '/opt/remaude/relay-state.json';
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// ---------- state (cookie secret + host tokens) ----------

let state = { cookieSecret: null, hosts: {} }; // hosts: token -> {email, name, createdAt}
try {
  state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
} catch {
  /* first run */
}
if (!state.cookieSecret) {
  state.cookieSecret = randomBytes(32).toString('hex');
  saveState();
}
if (!state.vapid) {
  state.vapid = webpush.generateVAPIDKeys();
  saveState();
}
if (!state.pushSubs) state.pushSubs = {}; // email -> [subscription]
// hosts paired before multiplexing have no id — give them one, the UI groups by it
let hostsMigrated = false;
for (const entry of Object.values(state.hosts ?? {}))
  if (!entry.id) {
    entry.id = randomUUID();
    hostsMigrated = true;
  }
if (hostsMigrated) saveState();
webpush.setVapidDetails(
  `mailto:${process.env.CONTACT_EMAIL ?? 'admin@example.com'}`,
  state.vapid.publicKey,
  state.vapid.privateKey
);

async function pushToUser(email, payload) {
  const subs = state.pushSubs[email] ?? [];
  const body = JSON.stringify(payload);
  let dirty = false;
  for (const sub of [...subs]) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        subs.splice(subs.indexOf(sub), 1); // the subscription is dead — clean it out
        dirty = true;
      } else {
        console.error('push failed:', e.statusCode ?? e.message);
      }
    }
  }
  if (dirty) saveState();
}
function saveState() {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- sessions: a stateless signed cookie ----------

function sign(data) {
  return createHmac('sha256', state.cookieSecret).update(data).digest('base64url');
}

function makeSessionCookie(email) {
  const exp = Date.now() + 90 * 24 * 3600e3;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// ---------- trusted devices ----------
// The same mechanism as host pairing, but in the opposite direction: an UNtrusted
// device shows a code from the site, and it is entered in the remaude settings on
// an already trusted device (or on the host's localhost). If it matches — the cookie is forever.

const devicePendings = new Map(); // code -> {email, pendingId, exp}
const deviceApproved = new Map(); // pendingId -> {email, exp}

function hasHosts(email) {
  return Object.values(state.hosts).some((h) => h.email === email);
}

/** A guest owns no hosts but still reaches someone else's machine. */
function isGuestSomewhere(email) {
  for (const links of hostLinks.values()) for (const link of links) if ((link.shareEmails ?? []).includes(email)) return true;
  return false;
}

/**
 * The client's public IP. Caddy proxies to 127.0.0.1, so we trust X-Forwarded-For
 * only when the socket came from Caddy itself — otherwise the header can be forged.
 */
function clientIp(req) {
  const socketIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (socketIp === '127.0.0.1' || socketIp === '::1') {
    // Caddy *appends* the real peer to whatever the client sent, so the last
    // element is the trustworthy one; the first is attacker-controlled and was
    // enough to fake "same network as the host" and skip device approval.
    const chain = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = chain.at(-1);
    if (last) return last.replace(/^::ffff:/, '');
  }
  return socketIp;
}

/** Comparing networks: IPv4 — an exact match, IPv6 — the /64 prefix (everyone has their own address). */
function sameNetwork(a, b) {
  if (!a || !b) return false;
  // safeguard: if XFF is suddenly not set, everyone looks like loopback — we trust no one
  if (a === '127.0.0.1' || a === '::1' || b === '127.0.0.1' || b === '::1') return false;
  if (a === b) return true;
  if (a.includes(':') && b.includes(':')) {
    const prefix = (ip) => ip.toLowerCase().split(':').slice(0, 4).join(':');
    return prefix(a) === prefix(b);
  }
  return false;
}

/** The device sits behind the same NAT as the user's host → it is at home. */
function sameNetworkAsHost(email, req) {
  const ip = clientIp(req);
  for (const link of hostLinks.get(email) ?? []) if (sameNetwork(ip, link.ip)) return true;
  return false;
}

function readPendingId(req) {
  return /(?:^|;\s*)rmd_device_pending=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
}

// Session and device cookies are signed with the same key, so without a type
// tag a stolen session cookie could be replayed as a device cookie — defeating
// the very gate that exists to backstop a stolen session.
function makeDeviceCookie(email) {
  const payload = Buffer.from(JSON.stringify({ typ: 'device', email, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readDevice(req) {
  const m = /(?:^|;\s*)rmd_device=([^;]+)/.exec(req.headers.cookie ?? '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.typ === 'device' ? (data.email ?? null) : null;
  } catch {
    return null;
  }
}

function readSession(req) {
  const m = /(?:^|;\s*)rmd_session=([^;]+)/.exec(req.headers.cookie ?? '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || sign(payload) !== sig) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() < exp ? email : null;
  } catch {
    return null;
  }
}

// ---------- live connections ----------

const hostLinks = new Map(); // email -> Set<link>; link = {ws, name, clients: Map<id, browserWs>}
const pairCodes = new Map(); // code -> {email, exp}
const oauthStates = new Map(); // state -> exp


// ---------- pages ----------

const PAGE_STYLE = `<style>body{background:#14151a;color:#d8dae4;font:15px/1.6 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:24px}h1{color:#7aa2f7;font-size:22px;letter-spacing:1px}
.btn,code{display:inline-block;margin-top:12px}.btn{background:#7aa2f7;color:#10141f;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600}
code{font-size:32px;letter-spacing:6px;background:#242732;padding:12px 20px;border-radius:10px}p.dim{color:#8a8fa3;font-size:13px}</style>`;

const loginPage = () => `<!doctype html><meta charset="utf-8"><title>remaude</title>${PAGE_STYLE}
<div class="box"><h1>remaude</h1><p>Sign-in for insiders only.</p><a class="btn" href="/auth/google">Sign in with Google</a></div>`;


const deniedPage = (email) => `<!doctype html><meta charset="utf-8"><title>remaude</title>${PAGE_STYLE}
<div class="box"><h1>not letting you in</h1><p>${email} is not on the list. If this is a mistake — ask the owner to add you.</p></div>`;

const devicePage = (code) => `<!doctype html><meta charset="utf-8"><title>remaude · new device</title>${PAGE_STYLE}
<div class="box"><h1>new device</h1>
<p>Enter this code in the remaude settings (⚙ → “code from the site”) on an already trusted device or right on the host computer:</p>
<code>${code}</code>
<p class="dim">The code lives for 10 minutes. As soon as you enter it — the page will open by itself.</p>
<script>setInterval(()=>fetch('/api/device/status').then(r=>r.json()).then(s=>{if(s.approved)location.reload()}).catch(()=>{}),3000)</script>
</div>`;

// ---------- HTTP ----------

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);
    const email = readSession(req);

    // -- OAuth --
    if (url.pathname === '/auth/google') {
      const st = randomUUID();
      oauthStates.set(st, Date.now() + 600e3);
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email',
        state: st,
        prompt: 'select_account',
      });
      res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}` }).end();
      return;
    }

    if (url.pathname === '/auth/google/callback') {
      const st = url.searchParams.get('state');
      if (!oauthStates.has(st) || oauthStates.get(st) < Date.now()) {
        res.writeHead(400).end('bad state');
        return;
      }
      oauthStates.delete(st);
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: url.searchParams.get('code'),
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: `${BASE_URL}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.id_token) {
        res.writeHead(401).end('oauth failed');
        return;
      }
      // the id_token came straight from Google over TLS — we verify the claims
      const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
      const userEmail = String(claims.email ?? '').toLowerCase();
      if (claims.aud !== CLIENT_ID || !claims.email_verified || !userEmail) {
        res.writeHead(401).end('bad token');
        return;
      }
      if (!WHITELIST.includes(userEmail)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(deniedPage(userEmail));
        return;
      }
      res
        .writeHead(302, {
          'set-cookie': `rmd_session=${makeSessionCookie(userEmail)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 24 * 3600}`,
          location: '/',
        })
        .end();
      return;
    }

    if (url.pathname === '/auth/logout') {
      res.writeHead(302, { 'set-cookie': 'rmd_session=; Path=/; Max-Age=0', location: '/' }).end();
      return;
    }

    // -- host pairing: the host redeems the one-time token from the invite link --
    if (url.pathname === '/pair' && req.method === 'POST') {
      const { code, name } = JSON.parse(await readBody(req));
      const entry = pairCodes.get(String(code));
      if (!entry || entry.exp < Date.now()) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad code' }));
        return;
      }
      pairCodes.delete(String(code));
      const token = randomBytes(32).toString('hex');
      state.hosts[token] = {
        id: randomUUID(),
        email: entry.email,
        name: String(name ?? 'host').slice(0, 60),
        createdAt: new Date().toISOString(),
      };
      saveState();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token, email: entry.email }));
      return;
    }

    if (url.pathname === '/api/push/key') {
      if (!email || readDevice(req) !== email) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ publicKey: state.vapid.publicKey }));
      return;
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      if (!email || readDevice(req) !== email) {
        res.writeHead(401).end();
        return;
      }
      const sub = JSON.parse(await readBody(req));
      if (!sub?.endpoint) {
        res.writeHead(400).end();
        return;
      }
      const subs = (state.pushSubs[email] ??= []);
      if (!subs.some((s) => s.endpoint === sub.endpoint)) {
        subs.push(sub);
        saveState();
      }
      res.writeHead(200).end('{}');
      return;
    }

    // -- invite link for a new host: open it (or curl it) on the host machine --
    // -- host bookkeeping: rename, unpair, sidebar order (all owner-only) --
    if (url.pathname.startsWith('/api/hosts/') && req.method === 'POST') {
      if (!email || readDevice(req) !== email) {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const ownedToken = (hostId) =>
        Object.entries(state.hosts).find(([, h]) => h.id === hostId && h.email === email)?.[0] ?? null;

      if (url.pathname === '/api/hosts/rename') {
        const token = ownedToken(body.hostId);
        if (!token) {
          res.writeHead(404).end();
          return;
        }
        state.hosts[token].name = String(body.name ?? '').trim().slice(0, 60) || state.hosts[token].name;
        saveState();
        for (const link of hostLinks.get(email) ?? []) if (link.hostId === body.hostId) link.name = state.hosts[token].name;
        refreshBrowsers();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }

      if (url.pathname === '/api/hosts/delete') {
        const token = ownedToken(body.hostId);
        if (!token) {
          res.writeHead(404).end();
          return;
        }
        delete state.hosts[token]; // the machine must be paired again to come back
        saveState();
        for (const link of [...(hostLinks.get(email) ?? [])])
          if (link.hostId === body.hostId) {
            link.ws.close(4401, 'unpaired');
            hostLinks.get(email).delete(link);
          }
        refreshBrowsers();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }

      if (url.pathname === '/api/hosts/order') {
        state.hostOrder ??= {};
        state.hostOrder[email] = (body.ids ?? []).filter((id) => typeof id === 'string');
        saveState();
        refreshBrowsers();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
    }

    if (url.pathname === '/api/host-link' && req.method === 'POST') {
      if (!email || readDevice(req) !== email) {
        res.writeHead(401).end();
        return;
      }
      const token = randomBytes(24).toString('base64url');
      pairCodes.set(token, { email, exp: Date.now() + 600e3 });
      const { port } = JSON.parse((await readBody(req)) || '{}');
      const hostPort = Number(port) || 7699;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          url: `http://localhost:${hostPort}/connect?token=${token}&relay=${encodeURIComponent(BASE_URL)}`,
          expiresInMinutes: 10,
        })
      );
      return;
    }

    if (url.pathname === '/api/me') {
      if (!email) {
        res.writeHead(401).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ email, hostsOnline: (hostLinks.get(email) ?? new Set()).size }));
      return;
    }

    // the host installer: we substitute the address of THIS relay, so that the repository
    // contains nobody's domain and any deployment serves its own users
    if (url.pathname === '/install.sh') {
      const script = (await readFile(join(WEB_ROOT, 'install.sh'), 'utf-8')).replaceAll('__RELAY_URL__', BASE_URL);
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' }).end(script);
      return;
    }

    // -- static files without authorization: the browser fetches the manifest/SW/icons without a cookie,
    // and there are no secrets in the static files — data travels only over the authorized WS --
    if (url.pathname !== '/') {
      const file = join(WEB_ROOT, url.pathname);
      if (file.startsWith(WEB_ROOT) && existsSync(file) && statSync(file).isFile()) {
        res
          .writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
          .end(await readFile(file));
        return;
      }
    }

    if (!email) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage());
      return;
    }

    // -- trusted device. As long as the account has no hosts, the gate is not needed
    // (there is nothing to protect) — the first device is trusted automatically, and that
    // is exactly the onboarding of a new user.
    // We trust the device if: the cookie is already there; the account still has no hosts (onboarding);
    // or it is behind the same NAT as the owner's host — that is, at home.
    // The onboarding exemption must not cover guests: they own no hosts, yet
    // they reach someone else's machine — so "nothing to protect" is false.
    const deviceOk =
      readDevice(req) === email ||
      (!hasHosts(email) && !isGuestSomewhere(email)) ||
      sameNetworkAsHost(email, req);
    // bootstrap trust (an account without hosts) has to materialize into a cookie right away,
    // otherwise /ws, which checks the cookie strictly, will not let a fresh guest in
    const bootstrapCookie =
      readDevice(req) !== email && deviceOk
        ? { 'set-cookie': `rmd_device=${makeDeviceCookie(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${2 * 365 * 24 * 3600}` }
        : {};

    // polling from the code page: has it been approved? (available without the device cookie)
    if (url.pathname === '/api/device/status') {
      const pendingId = readPendingId(req);
      const ok = deviceApproved.get(pendingId);
      if (ok && ok.email === email && ok.exp > Date.now()) {
        deviceApproved.delete(pendingId);
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': `rmd_device=${makeDeviceCookie(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${2 * 365 * 24 * 3600}`,
          })
          .end('{"approved":true}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":false}');
      }
      return;
    }

    if (!deviceOk) {
      // we show the code; coming back with the same pending cookie reuses the code
      let pendingId = readPendingId(req);
      let code = null;
      for (const [c, entry] of devicePendings) {
        if (entry.pendingId === pendingId && entry.email === email && entry.exp > Date.now()) code = c;
        if (entry.exp < Date.now()) devicePendings.delete(c);
      }
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (!code) {
        pendingId = randomUUID();
        code = String(randomInt(100000, 999999));
        devicePendings.set(code, { email, pendingId, exp: Date.now() + 600e3 });
        headers['set-cookie'] = `rmd_device_pending=${pendingId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
      }
      res.writeHead(200, headers).end(devicePage(code));
      return;
    }

    // The UI is served to every authorised user, with or without hosts: adding
    // the first host happens inside it, through an invite link.
    if (url.pathname === '/') {
      res
        .writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache', ...bootstrapCookie })
        .end(await readFile(join(WEB_ROOT, 'index.html')));
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error('http error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

// ---------- WebSocket: browsers (/ws) and hosts (/host) ----------

// files travel through here in pieces; a piece has to fit in a frame
const wssBrowser = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const wssHost = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
wssBrowser.on('error', () => {});
wssHost.on('error', () => {});

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, BASE_URL);
  if (url.pathname === '/ws') {
    const email = readSession(req);
    if (!email || (readDevice(req) !== email && !sameNetworkAsHost(email, req))) {
      socket.destroy();
      return;
    }
    wssBrowser.handleUpgrade(req, socket, head, (ws) => attachBrowser(ws, email));
  } else if (url.pathname === '/host') {
    const token = url.searchParams.get('token');
    const info = state.hosts[token];
    if (!info) {
      socket.destroy();
      return;
    }
    wssHost.handleUpgrade(req, socket, head, (ws) => attachHost(ws, info, clientIp(req)));
  } else {
    socket.destroy();
  }
});

/**
 * Every host this account may talk to: its own ones plus other people's hosts
 * that shared chats with it. A browser is attached to all of them at once, so
 * own and shared chats live side by side in one UI.
 */
function linksFor(email) {
  const result = [];
  for (const link of hostLinks.get(email) ?? []) result.push({ link, guest: null });
  for (const [ownerEmail, links] of hostLinks) {
    if (ownerEmail === email) continue;
    for (const link of links) {
      if ((link.shareEmails ?? []).includes(email)) result.push({ link, guest: { email } });
    }
  }
  return result;
}

const browsers = new Set(); // live browser sockets, for host list updates

function hostsSnapshot(email) {
  const order = state.hostOrder?.[email] ?? [];
  const rank = (id) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i; // unranked hosts sit after the ordered ones
  };
  return {
    type: 'hosts',
    hosts: linksFor(email)
      .map(({ link, guest }) => ({
        id: link.hostId,
        name: link.name,
        owner: link.ownerEmail,
        own: !guest,
      }))
      .sort((a, b) => rank(a.id) - rank(b.id)),
  };
}

/** Open a tunnel slot on every host currently available to this browser. */
function syncSlots(ws) {
  const wanted = new Map(linksFor(ws.email).map(({ link, guest }) => [link.hostId, { link, guest }]));

  for (const [hostId, slot] of ws.slots) {
    if (wanted.has(hostId)) continue; // still available
    slot.link.clients.delete(slot.id);
    if (slot.link.ws.readyState === slot.link.ws.OPEN)
      slot.link.ws.send(JSON.stringify({ t: 'close', id: slot.id }));
    ws.slots.delete(hostId);
  }

  for (const [hostId, { link, guest }] of wanted) {
    if (ws.slots.has(hostId)) continue;
    const id = randomUUID();
    link.clients.set(id, ws);
    ws.slots.set(hostId, { link, id });
    link.ws.send(JSON.stringify({ t: 'open', id, guest }));
  }

  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(hostsSnapshot(ws.email)));
}

function attachBrowser(ws, email) {
  ws.email = email;
  ws.slots = new Map(); // hostId -> {link, id}
  browsers.add(ws);
  syncSlots(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // _host routes the command to the host that owns the chat; without it we
    // fall back to the first slot, which keeps single-host clients working
    const slot = msg._host ? ws.slots.get(msg._host) : ws.slots.values().next().value;
    if (!slot) return;
    delete msg._host;
    slot.link.ws.send(JSON.stringify({ t: 'msg', id: slot.id, data: JSON.stringify(msg) }));
  });

  ws.on('close', () => {
    for (const slot of ws.slots.values()) {
      slot.link.clients.delete(slot.id);
      if (slot.link.ws.readyState === slot.link.ws.OPEN)
        slot.link.ws.send(JSON.stringify({ t: 'close', id: slot.id }));
    }
    browsers.delete(ws);
  });
  ws.on('error', () => {});
}

/** A host came or went: re-attach every browser that may see it. */
function refreshBrowsers() {
  for (const ws of browsers) if (ws.readyState === ws.OPEN) syncSlots(ws);
}

/** Tag a host message with its origin, so the browser can group chats by host. */
function tagged(data, hostId) {
  try {
    const obj = JSON.parse(data);
    obj._host = hostId;
    return JSON.stringify(obj);
  } catch {
    return data;
  }
}

function attachHost(ws, info, ip) {
  const link = { ws, name: info.name, ip, hostId: info.id, ownerEmail: info.email, clients: new Map() };
  if (!hostLinks.has(info.email)) hostLinks.set(info.email, new Set());
  hostLinks.get(info.email).add(link);
  console.log(`host online: ${info.name} (${info.email}) from ${ip}`);
  refreshBrowsers();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'msg') {
      const client = link.clients.get(msg.id);
      // no optional chaining on both sides: undefined === undefined is true,
      // and that exact self-own crashed the relay on messages to dead clients
      if (client && client.readyState === client.OPEN) client.send(tagged(msg.data, link.hostId));
    } else if (msg.t === 'cast') {
      const data = tagged(msg.data, link.hostId);
      for (const client of link.clients.values()) if (client.readyState === client.OPEN) client.send(data);
    } else if (msg.t === 'shares') {
      // just the guest list: the host decides what each of them may see
      link.shareEmails = Array.isArray(msg.emails)
        ? msg.emails
        : (msg.shares ?? []).flatMap((s) => s.emails ?? []); // older hosts sent per-session grants
      refreshBrowsers(); // a new share may open a slot for the guest right away
    } else if (msg.t === 'push') {
      pushToUser(info.email, { url: BASE_URL, ...msg.payload });
    } else if (msg.t === 'approve_device') {
      // a code from an untrusted device entered on a trusted one → we approve it
      const code = String(msg.code ?? '').trim();
      const entry = devicePendings.get(code);
      const ok = Boolean(entry && entry.email === info.email && entry.exp > Date.now());
      if (ok) {
        devicePendings.delete(code);
        deviceApproved.set(entry.pendingId, { email: info.email, exp: Date.now() + 600e3 });
      }
      ws.send(JSON.stringify({ t: 'device_approved', code, ok }));
    }
  });
  ws.on('close', () => {
    hostLinks.get(info.email)?.delete(link);
    // the browser stays connected: it simply loses this host's slot and chats
    for (const client of link.clients.values()) client.slots?.delete(link.hostId);
    console.log(`host offline: ${info.name} (${info.email})`);
    refreshBrowsers();
  });
  ws.on('error', () => {});
}

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] remaude relay on :${PORT}`);
});
