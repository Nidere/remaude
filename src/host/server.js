// Локальный сервер хост-агента: статика веб-UI + WebSocket-протокол.
// Слушает только 127.0.0.1 — наружу пойдём через relay (см. README).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { HostAgent } from './agent.js';
import { listSessions, loadHistory } from './transcripts.js';

const PORT = 7699;
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CONFIG_PATH = join(homedir(), '.remaude', 'host.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

// Корень проектов: настраивается в ~/.remaude/host.json (projectsRoot),
// по умолчанию — Documents\Projects, если есть, иначе домашняя папка.
const projectsRoot =
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
    }),
});

for (const p of config.projects) {
  try {
    agent.addProject(p);
  } catch (e) {
    console.error(`project unavailable: ${p} (${e.message})`);
  }
}

agent.on('chat_message', ({ chatId, msg }) => {
  // Пользовательский ввод рассылаем сами в handleSend (иначе дубли с replay'ем SDK),
  // поэтому чистые текстовые user-сообщения основного диалога здесь пропускаем.
  if (msg.type === 'user' && msg.parent_tool_use_id === null && !hasToolResult(msg)) return;
  if (msg.type !== 'stream_event') pushHistory(chatId, msg);
  broadcast({ type: 'chat_message', chatId, msg });
  if (msg.type === 'result') refreshLimits(true);
});
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

// ---------- WebSocket ----------

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function stateSnapshot() {
  return {
    type: 'state',
    projects: [...agent.projects.values()].map((p) => ({
      path: p.path,
      chats: [...p.chats.values()].map((c) => ({ id: c.id, sessionId: c.sessionId, status: c.status, title: c.title ?? null })),
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
    const userMsg = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
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
  open_session(ws, { projectPath, sessionId }) {
    for (const chat of agent.allChats()) {
      if (chat.sessionId === sessionId || chat.resumeId === sessionId) {
        send(ws, { type: 'chat_created', chatId: chat.id, projectPath });
        return;
      }
    }
    const abs = resolve(projectPath);
    const history = loadHistory(abs, sessionId);
    const meta = listSessions(abs).find((s) => s.id === sessionId);
    const chat = agent.createChat(abs, { resume: sessionId });
    chat.resumeId = sessionId;
    chat.title = meta?.title ?? meta?.preview?.slice(0, 60) ?? null;
    chatHistories.set(chat.id, history);
    broadcast(stateSnapshot());
    send(ws, { type: 'chat_created', chatId: chat.id, projectPath: abs });
  },

  interrupt(ws, { chatId }) {
    findChat(chatId).interrupt();
  },

  set_permission_mode(ws, { chatId, mode }) {
    findChat(chatId).setPermissionMode(mode);
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
wss.on('connection', (ws) => {
  clients.add(ws);
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
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      handlers[msg.type]?.(ws, msg);
    } catch (e) {
      send(ws, { type: 'error', message: String(e.message ?? e), inResponseTo: msg?.type });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`remaude host: http://localhost:${PORT}`);
});
