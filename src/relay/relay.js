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

// ---------- доверенные устройства ----------
// Тот же механизм, что пейринг хоста, в обратную сторону: НЕдоверенное
// устройство показывает код с сайта, а вводится он в настройках remaude на
// уже доверенном устройстве (или на локалхосте хоста). Совпало — кука навсегда.

const devicePendings = new Map(); // code -> {email, pendingId, exp}
const deviceApproved = new Map(); // pendingId -> {email, exp}

function hasHosts(email) {
  return Object.values(state.hosts).some((h) => h.email === email);
}

/**
 * Публичный IP клиента. Caddy проксирует на 127.0.0.1, поэтому X-Forwarded-For
 * доверяем только когда сокет пришёл от него самого — иначе заголовок подделывается.
 */
function clientIp(req) {
  const socketIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (socketIp === '127.0.0.1' || socketIp === '::1') {
    const xff = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (xff) return xff.replace(/^::ffff:/, '');
  }
  return socketIp;
}

/** Сравнение сетей: IPv4 — точное совпадение, IPv6 — префикс /64 (адрес у каждого свой). */
function sameNetwork(a, b) {
  if (!a || !b) return false;
  // страховка: если XFF вдруг не проставлен, все выглядят как loopback — не доверяем никому
  if (a === '127.0.0.1' || a === '::1' || b === '127.0.0.1' || b === '::1') return false;
  if (a === b) return true;
  if (a.includes(':') && b.includes(':')) {
    const prefix = (ip) => ip.toLowerCase().split(':').slice(0, 4).join(':');
    return prefix(a) === prefix(b);
  }
  return false;
}

/** Устройство сидит за тем же NAT, что и хост пользователя → дома. */
function sameNetworkAsHost(email, req) {
  const ip = clientIp(req);
  for (const link of hostLinks.get(email) ?? []) if (sameNetwork(ip, link.ip)) return true;
  return false;
}

function readPendingId(req) {
  return /(?:^|;\s*)rmd_device_pending=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
}

function makeDeviceCookie(email) {
  const payload = Buffer.from(JSON.stringify({ email, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readDevice(req) {
  const m = /(?:^|;\s*)rmd_device=([^;]+)/.exec(req.headers.cookie ?? '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || sign(payload) !== sig) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).email ?? null;
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

// ---------- живые соединения ----------

const hostLinks = new Map(); // email -> Set<link>; link = {ws, name, clients: Map<id, browserWs>}
const pairCodes = new Map(); // code -> {email, exp}
const oauthStates = new Map(); // state -> exp

function firstHostLink(email) {
  for (const link of hostLinks.get(email) ?? []) return link;
  return null;
}

/** Чужой хост-линк, где для email есть расшаренные чаты: {link, sessions}. */
function sharedLinkFor(email) {
  for (const [ownerEmail, links] of hostLinks) {
    if (ownerEmail === email) continue;
    for (const link of links) {
      const sessions = (link.shares ?? []).filter((s) => s.emails?.includes(email)).map((s) => s.sessionId);
      if (sessions.length) return { link, sessions };
    }
  }
  return null;
}

// ---------- страницы ----------

const PAGE_STYLE = `<style>body{background:#14151a;color:#d8dae4;font:15px/1.6 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:24px}h1{color:#7aa2f7;font-size:22px;letter-spacing:1px}
.btn,code{display:inline-block;margin-top:12px}.btn{background:#7aa2f7;color:#10141f;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600}
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

const devicePage = (code) => `<!doctype html><meta charset="utf-8"><title>remaude · новое устройство</title>${PAGE_STYLE}
<div class="box"><h1>новое устройство</h1>
<p>Введи этот код в настройках remaude (⚙ → «код с сайта») на уже доверенном устройстве или прямо на компьютере-хосте:</p>
<code>${code}</code>
<p class="dim">Код живёт 10 минут. Как только введёшь — страница откроется сама.</p>
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

    // -- статика без авторизации: манифест/SW/иконки браузер тянет без куки,
    // а секретов в статике нет — данные ходят только через авторизованный WS --
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

    // -- доверенное устройство. Пока у аккаунта нет хостов, гейт не нужен
    // (нечего защищать) — первое устройство доверяется автоматически, это
    // и есть онбординг нового пользователя.
    // Доверяем устройству, если: кука уже есть; аккаунт ещё без хостов (онбординг);
    // или оно за тем же NAT, что и хост владельца — то есть дома.
    const deviceOk = readDevice(req) === email || !hasHosts(email) || sameNetworkAsHost(email, req);
    // бутстрап-доверие (аккаунт без хостов) должен сразу материализоваться в куку,
    // иначе /ws, который проверяет куку жёстко, не пустит свежего гостя
    const bootstrapCookie =
      readDevice(req) !== email && deviceOk
        ? { 'set-cookie': `rmd_device=${makeDeviceCookie(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${2 * 365 * 24 * 3600}` }
        : {};

    // опрос со страницы кода: одобрили? (доступен без device-куки)
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
      // показываем код; повторный заход с той же pending-кукой переиспользует код
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

    if (url.pathname === '/') {
      if (!firstHostLink(email) && sharedLinkFor(email)) {
        // своего хоста нет, но есть расшаренные чаты — впускаем в UI гостем
        res
          .writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache', ...bootstrapCookie })
          .end(await readFile(join(WEB_ROOT, 'index.html')));
        return;
      }
      if (!firstHostLink(email)) {
        // хост не подключён: показываем код привязки
        const code = String(randomInt(100000, 999999));
        pairCodes.set(code, { email, exp: Date.now() + 600e3 });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...bootstrapCookie }).end(pairPage(code));
        return;
      }
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

// ---------- WebSocket: браузеры (/ws) и хосты (/host) ----------

const wssBrowser = new WebSocketServer({ noServer: true });
const wssHost = new WebSocketServer({ noServer: true });
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

function attachBrowser(ws, email) {
  let link = firstHostLink(email);
  let guest = null;
  if (!link) {
    const shared = sharedLinkFor(email);
    if (shared) {
      link = shared.link;
      guest = { email, sessions: shared.sessions };
    }
  }
  if (!link) {
    ws.close(4503, 'host offline');
    return;
  }
  const id = randomUUID();
  link.clients.set(id, ws);
  link.ws.send(JSON.stringify({ t: 'open', id, guest }));
  ws.on('message', (raw) => link.ws.send(JSON.stringify({ t: 'msg', id, data: raw.toString() })));
  ws.on('close', () => {
    link.clients.delete(id);
    if (link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify({ t: 'close', id }));
  });
}

function attachHost(ws, info, ip) {
  const link = { ws, name: info.name, ip, clients: new Map() };
  if (!hostLinks.has(info.email)) hostLinks.set(info.email, new Set());
  hostLinks.get(info.email).add(link);
  console.log(`host online: ${info.name} (${info.email}) from ${ip}`);
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
    } else if (msg.t === 'shares') {
      link.shares = Array.isArray(msg.shares) ? msg.shares : [];
    } else if (msg.t === 'approve_device') {
      // код с недоверенного устройства, введённый на доверенном → одобряем
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
