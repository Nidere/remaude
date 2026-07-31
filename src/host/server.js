// Локальный сервер хост-агента: статика веб-UI + WebSocket-протокол.
// Слушает только 127.0.0.1 — наружу пойдём через relay (см. README).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, statSync, readdirSync, openSync, mkdirSync } from 'node:fs';
import { homedir, userInfo, hostname } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { HostAgent } from './agent.js';
import { listSessions, loadHistory } from './transcripts.js';
import { RelayLink } from './relay-link.js';

const PORT = 7699;
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CONFIG_PATH = join(homedir(), '.remaude', 'host.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// ---------- конфиг (список проектов) ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { projects: [] };
  }
}

async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------- состояние ----------

const config = loadConfig();

// Имя автора сообщений (задел под групповые чаты): userName в host.json,
// по умолчанию — имя пользователя ОС.
let userName = config.userName ?? userInfo().username;

// Корень проектов: настраивается в ~/.remaude/host.json (projectsRoot),
// по умолчанию — Documents\Projects, если есть, иначе домашняя папка.
let projectsRoot =
  config.projectsRoot ??
  (existsSync(join(homedir(), 'Documents', 'Projects')) ? join(homedir(), 'Documents', 'Projects') : homedir());
const clients = new Set();
const pendingPermissions = new Map(); // requestId -> {resolve, chatId}
const chatHistories = new Map(); // chatId -> сообщения для replay при переподключении

const agent = new HostAgent({
  onPermissionRequest: ({ chat, toolName, input, suggestions, signal }) =>
    new Promise((resolvePerm) => {
      const requestId = randomUUID();
      pendingPermissions.set(requestId, {
        chatId: chat.id,
        toolName,
        input,
        suggestions,
        resolve: (result) => {
          pendingPermissions.delete(requestId);
          broadcast({ type: 'permission_closed', requestId });
          resolvePerm(result);
        },
      });
      signal.addEventListener('abort', () => {
        pendingPermissions.get(requestId)?.resolve({ behavior: 'deny', message: 'aborted' });
      });
      broadcast({ type: 'permission_request', requestId, chatId: chat.id, toolName, input, suggestions });
      relayLink?.push({
        title: 'remaude: ждёт разрешения',
        body: `${toolName} · ${chat.title ?? 'чат'}`,
        tag: `perm-${chat.id}`,
      });
    }),
});

for (const p of config.projects) {
  try {
    agent.addProject(p);
  } catch (e) {
    console.error(`project unavailable: ${p} (${e.message})`);
  }
}

// ---------- переживание рестартов: открытые чаты сохраняются и переоткрываются ----------

function saveOpenChats() {
  config.openChats = [...agent.allChats()]
    .filter((c) => c.status !== 'closed' && (c.sessionId || c.resumeId))
    .map((c) => ({
      projectPath: c.cwd,
      sessionId: c.sessionId ?? c.resumeId,
      title: c.title ?? null,
      permissionMode: c.permissionMode,
    }));
  saveConfig(config);
}

/** Общий путь открытия сохранённой сессии (open_session и автоподнятие при старте). */
function openSavedSession(projectPath, sessionId, { permissionMode, title } = {}) {
  for (const chat of agent.allChats()) {
    if (chat.sessionId === sessionId || chat.resumeId === sessionId) return chat;
  }
  const abs = resolve(projectPath);
  const chat = agent.createChat(abs, { resume: sessionId, permissionMode });
  chat.resumeId = sessionId;
  chat.title = title ?? null;
  chatHistories.set(chat.id, loadHistory(abs, sessionId, { defaultAuthor: userName }));
  return chat;
}

for (const oc of config.openChats ?? []) {
  try {
    openSavedSession(oc.projectPath, oc.sessionId, oc);
    console.log(`reopened: ${oc.title ?? oc.sessionId}`);
  } catch (e) {
    console.error(`reopen failed: ${oc.sessionId} (${e.message})`);
  }
}

agent.on('chat_message', ({ chatId, msg }) => {
  // Пользовательский ввод рассылаем сами в handleSend (иначе дубли с replay'ем SDK),
  // поэтому чистые текстовые user-сообщения основного диалога здесь пропускаем.
  if (msg.type === 'user' && msg.parent_tool_use_id === null && !hasToolResult(msg)) return;
  if (msg.type !== 'stream_event') pushHistory(chatId, msg);
  broadcast({ type: 'chat_message', chatId, msg });
  if (msg.type === 'system' && msg.subtype === 'init') {
    sendChatMeta(chatId);
    saveOpenChats(); // sessionId стал известен — зафиксировать для переоткрытия
  }
  if (msg.type === 'result') {
    refreshLimits(true);
    sendChatMeta(chatId);
    // никто не смотрит — стоит пискнуть на телефон
    if (clients.size === 0) {
      let title = null;
      try {
        title = findChat(chatId).title;
      } catch {
        /* чат мог закрыться */
      }
      relayLink?.push({ title: 'remaude: готово', body: title ?? 'задача завершена', tag: `done-${chatId}` });
    }
  }
});

/** Метаданные чата для хедера: модель, режим, заполненность контекста, усилия. */
async function sendChatMeta(chatId) {
  let chat;
  try {
    chat = findChat(chatId);
  } catch {
    return;
  }
  let context = null;
  try {
    const u = await chat.contextUsage();
    context = { percentage: Math.round(u.percentage), totalTokens: u.totalTokens, maxTokens: u.maxTokens };
    if (u.model) chat.model = u.model;
  } catch {
    /* сессия могла ещё не подняться или уже умереть */
  }
  broadcast({
    type: 'chat_meta',
    chatId,
    model: chat.model,
    permissionMode: chat.permissionMode,
    effort: chat.effort ?? hostEffort,
    context,
  });
}

// Усилия: эффективный дефолт хоста из настроек Claude Code (документированный дефолт — high)
let hostEffort = 'high';
try {
  const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
  if (settings.effortLevel) hostEffort = settings.effortLevel;
} catch {
  /* нет файла — остаёмся на high */
}
agent.on('chat_status', ({ chatId, status }) => broadcast({ type: 'chat_status', chatId, status }));
agent.on('chat_error', ({ chatId, error }) =>
  broadcast({ type: 'chat_error', chatId, error: String(error?.message ?? error) })
);

function hasToolResult(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'tool_result');
}

function pushHistory(chatId, msg) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  chatHistories.get(chatId).push(msg);
}

// ---------- лимиты (виджет) ----------

let lastLimitsAt = 0;
let lastLimits = null;
async function refreshLimits(force = false) {
  if (!force && Date.now() - lastLimitsAt < 60_000) return;
  const limits = await agent.limits();
  if (limits) {
    lastLimitsAt = Date.now();
    lastLimits = limits;
    broadcast({ type: 'limits', limits });
  }
}

// ---------- relay: туннель для удалённых браузеров ----------

const RELAY_DEFAULT_URL = 'https://remaude.nidere.com';
let relayLink = null;
const virtualClients = new Map(); // id -> VirtualClient
const pendingDeviceApprovals = new Map(); // code -> ws, ждущий ответа relay

/** Удалённый браузер, живущий за туннелем relay — с интерфейсом обычного ws-клиента. */
class VirtualClient {
  readyState = 1;
  OPEN = 1;
  constructor(id, guest = null) {
    this.id = id;
    this.guest = guest; // {email, sessions: [sessionId]} — гость расшаренных чатов
  }
  send(data) {
    relayLink?.sendTo(this.id, data);
  }
}

// ---------- шаринг чатов (гости) ----------

function sharesList() {
  return Object.entries(config.shares ?? {}).map(([sessionId, emails]) => ({ sessionId, emails }));
}

function announceShares() {
  relayLink?.setShares(sharesList());
}

/** id живых чатов, доступных гостю */
function guestChatIds(guest) {
  const ids = new Set();
  for (const chat of agent.allChats()) {
    const sid = chat.sessionId ?? chat.resumeId;
    if (sid && guest.sessions.includes(sid)) ids.add(chat.id);
  }
  return ids;
}

function guestState(guest) {
  const allowed = guestChatIds(guest);
  const snapshot = stateSnapshot();
  return {
    ...snapshot,
    guest: true,
    projects: snapshot.projects
      .map((p) => ({ ...p, chats: p.chats.filter((c) => allowed.has(c.id)) }))
      .filter((p) => p.chats.length),
  };
}

/** Что из трансляций видно гостю. */
function guestCanSee(guest, obj) {
  if (obj.type === 'chat_message' || obj.type === 'chat_status' || obj.type === 'chat_meta' || obj.type === 'chat_error')
    return guestChatIds(guest).has(obj.chatId);
  return false; // state обрабатывается отдельно; permissions/limits/relay — только владельцу
}

/** Команды, разрешённые гостям (и только по их чатам). */
const GUEST_TYPES = new Set(['send', 'history']);

function startRelay() {
  if (!config.relay?.token) return;
  relayLink?.stop();
  relayLink = new RelayLink(config.relay.url ?? RELAY_DEFAULT_URL, config.relay.token);
  relayLink.on('client_open', (id, guest) => {
    const vc = new VirtualClient(id, guest);
    virtualClients.set(id, vc);
    initClient(vc);
  });
  relayLink.on('client_msg', (id, data) => {
    const vc = virtualClients.get(id);
    if (vc) dispatch(vc, data);
  });
  relayLink.on('client_close', (id) => {
    clients.delete(virtualClients.get(id));
    virtualClients.delete(id);
  });
  relayLink.on('down', () => {
    for (const vc of virtualClients.values()) clients.delete(vc);
    virtualClients.clear();
  });
  relayLink.on('status', (up) => {
    console.log(`relay ${up ? 'connected' : 'disconnected'}`);
    if (up) announceShares();
    broadcast({ type: 'relay_status', paired: true, connected: up });
  });
  relayLink.on('device_approved', (code, ok) => {
    const requester = pendingDeviceApprovals.get(code);
    pendingDeviceApprovals.delete(code);
    if (requester)
      send(
        requester,
        ok
          ? { type: 'device_approved' }
          : { type: 'error', message: 'relay не принял код устройства (истёк или опечатка)' }
      );
  });
}

// ---------- аутентификация Claude на хосте (логин из веб-UI) ----------

let loginChild = null; // единственный активный процесс `claude auth login`

function runClaudeJson(args) {
  return new Promise((resolveRun) => {
    const p = spawn('claude', args, { shell: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        resolveRun(JSON.parse(out));
      } catch {
        resolveRun(null);
      }
    });
    p.on('error', () => resolveRun(null));
  });
}

async function claudeAuthStatus() {
  const st = await runClaudeJson(['auth', 'status']);
  return st ? { loggedIn: st.loggedIn, email: st.email, subscriptionType: st.subscriptionType } : null;
}

// ---------- WebSocket ----------

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.guest) {
      // гостям — только их чаты; state пересобирается под их скоуп
      if (obj.type === 'state') ws.send(JSON.stringify(guestState(ws.guest)));
      else if (guestCanSee(ws.guest, obj)) ws.send(data);
      continue;
    }
    ws.send(data);
  }
}

function stateSnapshot() {
  return {
    type: 'state',
    projects: [...agent.projects.values()].map((p) => ({
      path: p.path,
      chats: [...p.chats.values()].map((c) => ({
        id: c.id,
        sessionId: c.sessionId,
        status: c.status,
        title: c.title ?? null,
        model: c.model,
        permissionMode: c.permissionMode,
      })),
    })),
  };
}

const handlers = {
  add_project(ws, { path }) {
    agent.addProject(path);
    const abs = resolve(path);
    if (!config.projects.includes(abs)) {
      config.projects.push(abs);
      saveConfig(config);
    }
    broadcast(stateSnapshot());
  },

  /** Подпапки корня проектов — для выбора с любого устройства, включая телефон. */
  list_root(ws) {
    let dirs = [];
    let error = null;
    try {
      dirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      error = e.message;
    }
    send(ws, { type: 'root_listing', root: projectsRoot, dirs, added: [...agent.projects.keys()], error });
  },

  /** Убрать проект из панели: чаты закрываются, на диске ничего не трогаем. */
  close_project(ws, { path }) {
    const abs = resolve(path);
    const project = agent.projects.get(abs);
    if (project) {
      for (const chat of project.chats.values()) {
        chat.close();
        chatHistories.delete(chat.id);
      }
      agent.projects.delete(abs);
    }
    config.projects = (config.projects ?? []).filter((p) => resolve(p) !== abs);
    saveOpenChats(); // пересобирает список открытых чатов из живых — закрытые уйдут
    broadcast(stateSnapshot());
  },

  add_from_root(ws, { name }) {
    if (name.includes('/') || name.includes('\\') || name === '..') throw new Error('bad name');
    handlers.add_project(ws, { path: join(projectsRoot, name) });
  },

  create_chat(ws, { projectPath, model, permissionMode }) {
    const chat = agent.createChat(projectPath, { model, permissionMode });
    broadcast(stateSnapshot());
    send(ws, { type: 'chat_created', chatId: chat.id, projectPath: chat.cwd });
  },

  send(ws, { chatId, content }) {
    const chat = findChat(chatId);
    chat.send(content);
    if (!chat.title) {
      const text = typeof content === 'string' ? content : content.find?.((b) => b.type === 'text')?.text;
      if (text) {
        chat.title = text.slice(0, 60);
        broadcast(stateSnapshot());
      }
    }
    const userMsg = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
      timestamp: new Date().toISOString(),
      author: ws.guest ? ws.guest.email.split('@')[0] : userName,
    };
    pushHistory(chatId, userMsg);
    broadcast({ type: 'chat_message', chatId, msg: userMsg });
  },

  /** Сохранённые на диске сессии проекта (включая созданные в VS Code/CLI). */
  list_sessions(ws, { projectPath }) {
    const live = {};
    for (const chat of agent.allChats()) {
      if (chat.sessionId) live[chat.sessionId] = chat.id;
      if (chat.resumeId) live[chat.resumeId] = chat.id;
    }
    send(ws, { type: 'sessions', projectPath, sessions: listSessions(resolve(projectPath)), live });
  },

  /** Возобновить сохранённую сессию: история — из транскрипта, контекст — resume в SDK. */
  open_session(ws, { projectPath, sessionId, permissionMode }) {
    const abs = resolve(projectPath);
    const meta = listSessions(abs).find((s) => s.id === sessionId);
    const chat = openSavedSession(abs, sessionId, {
      permissionMode,
      title: meta?.title ?? meta?.preview?.slice(0, 60) ?? null,
    });
    saveOpenChats();
    broadcast(stateSnapshot());
    send(ws, { type: 'chat_created', chatId: chat.id, projectPath: abs });
  },

  interrupt(ws, { chatId }) {
    findChat(chatId).interrupt();
  },

  set_permission_mode(ws, { chatId, mode }) {
    findChat(chatId).setPermissionMode(mode);
    saveOpenChats();
    broadcast({ type: 'permission_mode', chatId, mode });
  },

  permission_response(ws, { requestId, result }) {
    pendingPermissions.get(requestId)?.resolve(result);
  },

  history(ws, { chatId }) {
    send(ws, { type: 'history', chatId, messages: chatHistories.get(chatId) ?? [] });
  },

  get_limits() {
    refreshLimits(true);
  },

  /** Дать/забрать доступ к чату по почте. Ключ — стабильный sessionId. */
  share_chat(ws, { chatId, email }) {
    const chat = findChat(chatId);
    const sid = chat.sessionId ?? chat.resumeId;
    if (!sid) throw new Error('у чата ещё нет session id — отправь в него хоть одно сообщение');
    config.shares ??= {};
    const emails = (config.shares[sid] ??= []);
    const clean = String(email).trim().toLowerCase();
    if (!emails.includes(clean)) emails.push(clean);
    saveConfig(config);
    announceShares();
    send(ws, { type: 'share_result', chatId, emails });
  },

  unshare_chat(ws, { chatId }) {
    const chat = findChat(chatId);
    const sid = chat.sessionId ?? chat.resumeId;
    if (sid && config.shares?.[sid]) {
      delete config.shares[sid];
      saveConfig(config);
      announceShares();
    }
    send(ws, { type: 'share_result', chatId, emails: [] });
  },

  rename_chat(ws, { chatId, title }) {
    findChat(chatId).title = String(title).slice(0, 80);
    saveOpenChats();
    broadcast(stateSnapshot());
  },

  /** Закрыть чат и убрать из сайдбара; транскрипт остаётся, возобновим через open_session. */
  hide_chat(ws, { chatId }) {
    const chat = findChat(chatId);
    chat.close();
    for (const p of agent.projects.values()) p.chats.delete(chatId);
    chatHistories.delete(chatId);
    saveOpenChats();
    broadcast(stateSnapshot());
  },

  async set_model(ws, { chatId, model }) {
    await findChat(chatId).setModel(model);
    sendChatMeta(chatId);
  },

  async set_effort(ws, { chatId, effort }) {
    await findChat(chatId).setEffort(effort);
    sendChatMeta(chatId);
  },

  async get_settings(ws) {
    send(ws, {
      type: 'settings',
      userName,
      projectsRoot,
      relay: {
        paired: Boolean(config.relay?.token),
        connected: relayLink?.connected ?? false,
        url: config.relay?.url ?? RELAY_DEFAULT_URL,
      },
      claudeAuth: await claudeAuthStatus(),
    });
  },

  /** Запустить `claude auth login`: ссылку — в UI, код вернётся через claude_login_code. */
  claude_login_start(ws) {
    loginChild?.kill();
    const child = spawn('claude', ['auth', 'login'], { shell: true });
    loginChild = child;
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = /https:\/\/\S+/.exec(buf.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) {
        send(ws, { type: 'claude_login_url', url: m[0] });
        child.stdout.off('data', onData);
      }
    };
    child.stdout.on('data', onData);
    child.on('close', async () => {
      if (loginChild === child) loginChild = null;
      broadcast({ type: 'claude_auth', status: await claudeAuthStatus() });
    });
    child.on('error', () => send(ws, { type: 'error', message: 'не удалось запустить claude auth login' }));
    setTimeout(() => child === loginChild && child.kill(), 600e3); // не висим вечно
  },

  claude_login_code(ws, { code }) {
    if (!loginChild) throw new Error('логин-процесс не запущен (начни заново)');
    loginChild.stdin.write(String(code).trim() + '\n');
  },

  /**
   * Единое поле «код с сайта»: если хост ещё не привязан — это привязка хоста,
   * если привязан — одобрение нового устройства (тот же механизм, обратная сторона).
   */
  async pair_relay(ws, { code, url }) {
    if (config.relay?.token) {
      pendingDeviceApprovals.set(String(code).trim(), ws);
      relayLink.approveDevice(code);
      return;
    }
    const base = (url ?? config.relay?.url ?? RELAY_DEFAULT_URL).replace(/\/$/, '');
    const res = await fetch(base + '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code).trim(), name: hostname() }),
    });
    if (!res.ok) throw new Error('relay не принял код (истёк или опечатка)');
    const { token } = await res.json();
    config.relay = { url: base, token };
    saveConfig(config);
    startRelay();
    handlers.get_settings(ws);
  },

  set_settings(ws, { userName: newName, projectsRoot: newRoot }) {
    if (newName) {
      userName = newName;
      config.userName = newName;
    }
    if (newRoot && existsSync(newRoot) && statSync(newRoot).isDirectory()) {
      projectsRoot = resolve(newRoot);
      config.projectsRoot = projectsRoot;
    }
    saveConfig(config);
  },

  /**
   * Самоперезапуск: порождаем отвязанную копию себя и выходим. Копия
   * ретраит listen, пока мы не отпустим порт. Все живые SDK-сессии умирают —
   * они возобновляемы через open_session.
   */
  restart_server() {
    console.log('restart requested');
    broadcast({ type: 'server_restarting' });
    // под супервизором (launchd/systemd) достаточно выйти — он перезапустит сам
    if (process.env.REMAUDE_SUPERVISED) {
      setTimeout(() => process.exit(0), 300);
      return;
    }
    // stdio копии — в файлы: молчаливая смерть наследника недиагностируема
    const logDir = join(homedir(), '.remaude');
    mkdirSync(logDir, { recursive: true });
    const out = openSync(join(logDir, 'server.log'), 'a');
    const err = openSync(join(logDir, 'server.err.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      detached: true,
      stdio: ['ignore', out, err],
      cwd: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
      windowsHide: true,
    });
    child.on('error', (e) => console.error('restart spawn failed:', e));
    child.unref();
    console.log(`restart: spawned pid ${child.pid}`);
    setTimeout(() => process.exit(0), 300);
  },
};

function findChat(chatId) {
  for (const chat of agent.allChats()) if (chat.id === chatId) return chat;
  throw new Error(`no such chat: ${chatId}`);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- HTTP (статика) ----------

const httpServer = createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = join(WEB_ROOT, path);
    if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache', // dev: иначе браузеры прилипают к старому app.js
    });
    res.end(await readFile(file));
  } catch (e) {
    console.error('http error:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

// Хост должен жить всегда: любые неожиданные ошибки логируем, не падаем.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
// ws переизлучает ошибки httpServer на себя; без слушателя это роняет процесс
// раньше, чем сработает наш listen-ретрай ниже (проверено experiments/listen-retry-min.mjs)
wss.on('error', () => {});
/** Единая инициализация клиента — локального WS и туннельного через relay. */
function initClient(ws) {
  clients.add(ws);
  if (ws.guest) {
    send(ws, guestState(ws.guest)); // гостям — только их чаты, без лимитов и permissions
    return;
  }
  send(ws, stateSnapshot());
  if (lastLimits) send(ws, { type: 'limits', limits: lastLimits });
  refreshLimits();
  // незакрытые permission-запросы — новому клиенту тоже
  for (const [requestId, p] of pendingPermissions) {
    send(ws, {
      type: 'permission_request',
      requestId,
      chatId: p.chatId,
      toolName: p.toolName,
      input: p.input,
      suggestions: p.suggestions,
    });
  }
  if (relayLink) send(ws, { type: 'relay_status', paired: true, connected: relayLink.connected });
}

/** Единый диспетчер входящих сообщений. */
function dispatch(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
    if (ws.guest) {
      if (!GUEST_TYPES.has(msg.type)) throw new Error('это может только владелец хоста');
      if (msg.chatId && !guestChatIds(ws.guest).has(msg.chatId)) throw new Error('нет доступа к этому чату');
    }
    // async-обработчики тоже должны доносить ошибки до клиента
    Promise.resolve(handlers[msg.type]?.(ws, msg)).catch((e) =>
      send(ws, { type: 'error', message: String(e.message ?? e), inResponseTo: msg?.type })
    );
  } catch (e) {
    send(ws, { type: 'error', message: String(e.message ?? e), inResponseTo: msg?.type });
  }
}

wss.on('connection', (ws) => {
  initClient(ws);
  ws.on('message', (raw) => dispatch(ws, raw));
  ws.on('close', () => clients.delete(ws));
});

startRelay();

// Ретрай listen: при самоперезапуске новая копия ждёт, пока старая отпустит порт.
let listenAttempts = 0;
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && listenAttempts < 40) {
    listenAttempts++;
    setTimeout(() => httpServer.listen(PORT, '127.0.0.1'), 500);
  } else {
    console.error('listen failed:', e.message);
    process.exit(1);
  }
});
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] remaude host: http://localhost:${PORT} (pid ${process.pid})`);
});
