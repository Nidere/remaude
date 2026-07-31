// remaude relay: публичная точка входа (remaude.nidere.com).
// Браузеры: статика веб-UI + Google OAuth (whitelist) + WSS /ws.
// Хосты: исходящий WSS /host?token=… ; пейринг: POST /pair {code}.
// Контент чатов не хранится — только маршрутизация и учёт токенов хостов.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';

const PORT = Number(process.env.PORT ?? 8080);
const BASE_URL = process.env.BASE_URL ?? 'https://remaude.nidere.com';
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

// ---------- состояние (cookie-секрет + токены хостов) ----------

let state = { cookieSecret: null, hosts: {} }; // hosts: token -> {email, name, createdAt}
try {
  state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
} catch {
  /* первый запуск */
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
webpush.setVapidDetails('mailto:nikita@nidere.com', state.vapid.publicKey, state.vapid.privateKey);

async function pushToUser(email, payload) {
  const subs = state.pushSubs[email] ?? [];
  const body = JSON.stringify(payload);
  let dirty = false;
  for (const sub of [...subs]) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        subs.splice(subs.indexOf(sub), 1); // подписка умерла — вычищаем
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

// ---------- сессии: stateless подписанная кука ----------

function sign(data) {
  return createHmac('sha256', state.cookieSecret).update(data).digest('base64url');
}

function makeSessionCookie(email) {
  const exp = Date.now() + 90 * 24 * 3600e3;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
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

// ---------- живые соединения ----------

const hostLinks = new Map(); // email -> Set<link>; link = {ws, name, clients: Map<id, browserWs>}
const pairCodes = new Map(); // code -> {email, exp}
const oauthStates = new Map(); // state -> exp

function firstHostLink(email) {
  for (const link of hostLinks.get(email) ?? []) return link;
  return null;
}

// ---------- страницы ----------

const PAGE_STYLE = `<style>body{background:#14151a;color:#d8dae4;font:15px/1.6 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:24px}h1{color:#7aa2f7;font-size:22px;letter-spacing:1px}
a.btn,code{display:inline-block;margin-top:12px}a.btn{background:#7aa2f7;color:#10141f;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600}
code{font-size:32px;letter-spacing:6px;background:#242732;padding:12px 20px;border-radius:10px}p.dim{color:#8a8fa3;font-size:13px}</style>`;

const loginPage = () => `<!doctype html><meta charset="utf-8"><title>remaude</title>${PAGE_STYLE}
<div class="box"><h1>remaude</h1><p>Вход только для своих.</p><a class="btn" href="/auth/google">Войти через Google</a></div>`;

const pairPage = (code) => `<!doctype html><meta charset="utf-8"><title>remaude · привязка</title>${PAGE_STYLE}
<div class="box"><h1>привязка хоста</h1>
<p>На машине с Claude Code открой локальный remaude (localhost:7699) → ⚙ настройки → «Привязка к relay» и введи код:</p>
<code>${code}</code>
<p class="dim">Код живёт 10 минут. После привязки обнови эту страницу.</p></div>`;

const deniedPage = (email) => `<!doctype html><meta charset="utf-8"><title>remaude</title>${PAGE_STYLE}
<div class="box"><h1>не пускаю</h1><p>${email} нет в списке. Если это ошибка — попроси владельца добавить тебя.</p></div>`;

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
      // id_token получен напрямую от Google по TLS — проверяем клеймы
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

    // -- пейринг хоста (без сессии: хост шлёт одноразовый код) --
    if (url.pathname === '/pair' && req.method === 'POST') {
      const { code, name } = JSON.parse(await readBody(req));
      const entry = pairCodes.get(String(code));
      if (!entry || entry.exp < Date.now()) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad code' }));
        return;
      }
      pairCodes.delete(String(code));
      const token = randomBytes(32).toString('hex');
      state.hosts[token] = { email: entry.email, name: String(name ?? 'host').slice(0, 60), createdAt: new Date().toISOString() };
      saveState();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token, email: entry.email }));
      return;
    }

    if (url.pathname === '/api/push/key') {
      if (!email) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ publicKey: state.vapid.publicKey }));
      return;
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      if (!email) {
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

    // -- страницы/статика --
    if (!email) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage());
      return;
    }

    if (url.pathname === '/') {
      if (!firstHostLink(email)) {
        // хост не подключён: показываем код привязки
        const code = String(randomInt(100000, 999999));
        pairCodes.set(code, { email, exp: Date.now() + 600e3 });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pairPage(code));
        return;
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(await readFile(join(WEB_ROOT, 'index.html')));
      return;
    }

    const file = join(WEB_ROOT, url.pathname);
    if (file.startsWith(WEB_ROOT) && existsSync(file) && statSync(file).isFile()) {
      res
        .writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
        .end(await readFile(file));
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error('http error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

// ---------- WebSocket: браузеры (/ws) и хосты (/host) ----------

const wssBrowser = new WebSocketServer({ noServer: true });
const wssHost = new WebSocketServer({ noServer: true });
wssBrowser.on('error', () => {});
wssHost.on('error', () => {});

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, BASE_URL);
  if (url.pathname === '/ws') {
    const email = readSession(req);
    if (!email) {
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
    wssHost.handleUpgrade(req, socket, head, (ws) => attachHost(ws, info));
  } else {
    socket.destroy();
  }
});

function attachBrowser(ws, email) {
  const link = firstHostLink(email);
  if (!link) {
    ws.close(4503, 'host offline');
    return;
  }
  const id = randomUUID();
  link.clients.set(id, ws);
  link.ws.send(JSON.stringify({ t: 'open', id }));
  ws.on('message', (raw) => link.ws.send(JSON.stringify({ t: 'msg', id, data: raw.toString() })));
  ws.on('close', () => {
    link.clients.delete(id);
    if (link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify({ t: 'close', id }));
  });
}

function attachHost(ws, info) {
  const link = { ws, name: info.name, clients: new Map() };
  if (!hostLinks.has(info.email)) hostLinks.set(info.email, new Set());
  hostLinks.get(info.email).add(link);
  console.log(`host online: ${info.name} (${info.email})`);
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'msg') {
      const client = link.clients.get(msg.id);
      if (client?.readyState === client?.OPEN) client.send(msg.data);
    } else if (msg.t === 'cast') {
      for (const client of link.clients.values()) if (client.readyState === client.OPEN) client.send(msg.data);
    } else if (msg.t === 'push') {
      pushToUser(info.email, { url: BASE_URL, ...msg.payload });
    }
  });
  ws.on('close', () => {
    hostLinks.get(info.email)?.delete(link);
    for (const client of link.clients.values()) client.close(4504, 'host disconnected');
    console.log(`host offline: ${info.name} (${info.email})`);
  });
  ws.on('error', () => {});
}

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] remaude relay on :${PORT}`);
});
