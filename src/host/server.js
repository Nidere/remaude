// The host agent's local server: the web UI's static files + the WebSocket protocol.
// It only listens on 127.0.0.1 — we reach the outside world through the relay (see README).
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

// ---------- config (list of projects) ----------

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

// ---------- state ----------

const config = loadConfig();

// The author name on messages (groundwork for group chats): userName in host.json,
// defaulting to the OS user name.
let userName = config.userName ?? userInfo().username;

// The projects root: configured in ~/.remaude/host.json (projectsRoot),
// defaulting to Documents\Projects if it exists, otherwise the home folder.
let projectsRoot =
  config.projectsRoot ??
  (existsSync(join(homedir(), 'Documents', 'Projects')) ? join(homedir(), 'Documents', 'Projects') : homedir());
const clients = new Set();
const pendingPermissions = new Map(); // requestId -> {resolve, chatId}
const chatHistories = new Map(); // chatId -> messages to replay on reconnect

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
        title: 'remaude: waiting for permission',
        body: `${toolName} · ${chat.title ?? 'chat'}`,
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

// ---------- surviving restarts: open chats are saved and reopened ----------

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

/** The shared path for opening a saved session (open_session and the auto-restore at startup). */
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
  // We broadcast user input ourselves in handleSend (otherwise it duplicates with the SDK's
  // replay), so plain text user messages of the main dialogue are skipped here.
  if (msg.type === 'user' && msg.parent_tool_use_id === null && !hasToolResult(msg)) return;
  if (msg.type !== 'stream_event') pushHistory(chatId, msg);
  broadcast({ type: 'chat_message', chatId, msg });
  if (msg.type === 'system' && msg.subtype === 'init') {
    sendChatMeta(chatId);
    saveOpenChats(); // the sessionId is now known — record it so we can reopen the chat
  }
  // remember what was actually said last: that, not the chat name, is what makes
  // a completion notification worth reading
  if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
    const text = (msg.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text) lastReplies.set(chatId, text);
  }
  if (msg.type === 'result') {
    refreshLimits(true);
    sendChatMeta(chatId);
    // nobody has this chat on screen — worth buzzing the phone. Merely having a
    // tab open elsewhere must not silence it, or the push never fires at all.
    if (![...clients].some((c) => c.watching === chatId)) {
      let title = null;
      try {
        title = findChat(chatId).title;
      } catch {
        /* the chat may have been closed */
      }
      const reply = lastReplies.get(chatId);
      relayLink?.push({
        title: title ? title.replace(/\s+/g, ' ').slice(0, 40) : 'remaude',
        body: reply ? reply.replace(/\s+/g, ' ').slice(0, 200) : 'task finished',
        tag: `done-${chatId}`,
      });
    }
    lastReplies.delete(chatId);
  }
});

const lastReplies = new Map(); // chatId -> last assistant text, for the push body

/** Chat metadata for the header: model, mode, how full the context is, effort. */
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
    /* the session may not have started up yet, or may already be dead */
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

// Effort: the host's effective default taken from the Claude Code settings (the documented default is high)
let hostEffort = 'high';
try {
  const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
  if (settings.effortLevel) hostEffort = settings.effortLevel;
} catch {
  /* no such file — we stay on high */
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

// ---------- limits (widget) ----------

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

// ---------- relay: the tunnel for remote browsers ----------

// The relay address comes from the environment (the installer writes it there) or from the
// config; there are no hardcoded domains in the code — anyone can deploy this project.
const RELAY_DEFAULT_URL = process.env.REMAUDE_RELAY_URL ?? config.relayUrl ?? null;
let relayLink = null;
const virtualClients = new Map(); // id -> VirtualClient
const pendingDeviceApprovals = new Map(); // code -> the ws waiting for the relay's answer

/** A remote browser living behind the relay tunnel — with the interface of a regular ws client. */
class VirtualClient {
  readyState = 1;
  OPEN = 1;
  constructor(id, guest = null) {
    this.id = id;
    this.guest = guest; // {email, sessions: [sessionId]} — a guest of the shared chats
  }
  send(data) {
    relayLink?.sendTo(this.id, data);
  }
}

// ---------- chat sharing (guests) ----------

function sharesList() {
  return Object.entries(config.shares ?? {}).map(([sessionId, emails]) => ({ sessionId, emails }));
}

function announceShares() {
  relayLink?.setShares(sharesList());
}

/** ids of the live chats available to a guest */
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

/** Which of the broadcasts a guest gets to see. */
function guestCanSee(guest, obj) {
  if (obj.type === 'chat_message' || obj.type === 'chat_status' || obj.type === 'chat_meta' || obj.type === 'chat_error')
    return guestChatIds(guest).has(obj.chatId);
  return false; // state is handled separately; permissions/limits/relay — owner only
}

/** The commands allowed to guests (and only on their own chats). */
const GUEST_TYPES = new Set(['send', 'history', 'focus']);

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
          : { type: 'error', message: 'the relay did not accept the device code (expired or mistyped)' }
      );
  });
}

// ---------- Claude authentication on the host (logging in from the web UI) ----------

let loginChild = null; // the single active `claude auth login` process

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
      // guests get only their own chats; state is rebuilt to match their scope
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

  /** Subfolders of the projects root — so they can be picked from any device, phones included. */
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

  /** Remove a project from the sidebar: its chats are closed, nothing on disk is touched. */
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
    saveOpenChats(); // rebuilds the list of open chats from the live ones — the closed ones drop out
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

  /** The project's sessions saved on disk (including ones created in VS Code/the CLI). */
  list_sessions(ws, { projectPath }) {
    const live = {};
    for (const chat of agent.allChats()) {
      if (chat.sessionId) live[chat.sessionId] = chat.id;
      if (chat.resumeId) live[chat.resumeId] = chat.id;
    }
    send(ws, { type: 'sessions', projectPath, sessions: listSessions(resolve(projectPath)), live });
  },

  /** Resume a saved session: history comes from the transcript, context from the SDK's resume. */
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

  /** Which chat this client is looking at right now (null when hidden). */
  focus(ws, { chatId }) {
    ws.watching = chatId ?? null;
  },

  /** Grant/revoke access to a chat by email. The key is the stable sessionId. */
  share_chat(ws, { chatId, email }) {
    const chat = findChat(chatId);
    const sid = chat.sessionId ?? chat.resumeId;
    if (!sid) throw new Error('this chat has no session id yet — send at least one message into it');
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

  /** Close a chat and remove it from the sidebar; the transcript stays, we resume it via open_session. */
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
        url: config.relay?.url ?? RELAY_DEFAULT_URL ?? '',
      },
      claudeAuth: await claudeAuthStatus(),
    });
  },

  /** Start `claude auth login`: the link goes to the UI, the code comes back via claude_login_code. */
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
    child.on('error', () => send(ws, { type: 'error', message: 'failed to start claude auth login' }));
    setTimeout(() => child === loginChild && child.kill(), 600e3); // don't hang around forever
  },

  claude_login_code(ws, { code }) {
    if (!loginChild) throw new Error('the login process is not running (start over)');
    loginChild.stdin.write(String(code).trim() + '\n');
  },

  /**
   * A single "code from the website" field: if the host is not paired yet, this pairs the host;
   * if it is paired, this approves a new device (the same mechanism, seen from the other side).
   */
  async pair_relay(ws, { code }) {
    if (!config.relay?.token) throw new Error('this host is not paired yet — use the invite link from the relay UI');
    pendingDeviceApprovals.set(String(code).trim(), ws);
    relayLink.approveDevice(code);
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
   * Self-restart: we spawn a detached copy of ourselves and exit. The copy keeps
   * retrying listen until we release the port. All live SDK sessions die — but
   * they can be resumed through open_session.
   */
  restart_server() {
    console.log('restart requested');
    broadcast({ type: 'server_restarting' });
    // under a supervisor (launchd/systemd) exiting is enough — it will restart us itself
    if (process.env.REMAUDE_SUPERVISED) {
      setTimeout(() => process.exit(0), 300);
      return;
    }
    // the copy's stdio goes to files: a silent death of the successor is impossible to diagnose
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

// ---------- HTTP (static files) ----------

/**
 * Redeem the one-time token from the relay's invite link: the host learns which
 * relay (and thereby which account) it belongs to, and keeps the token it gets
 * back. This is the only moment identity crosses over to this machine, which is
 * why the route lives on localhost only.
 */
async function redeemInvite(token, relayUrl) {
  const base = String(relayUrl ?? config.relay?.url ?? RELAY_DEFAULT_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('the invite link carries no relay address');
  const res = await fetch(base + '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(token).trim(), name: hostname() }),
  });
  if (!res.ok) throw new Error('the relay rejected this invite link (expired or already used)');
  const { token: hostToken, email } = await res.json();
  config.relay = { url: base, token: hostToken };
  saveConfig(config);
  startRelay();
  broadcast({ type: 'relay_status', paired: true, connected: false });
  return { base, email };
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // the invite link from the relay UI: open it in a browser on this machine
    // or simply curl it — both land here
    if (url.pathname === '/connect') {
      const wantsHtml = (req.headers.accept ?? '').includes('text/html');
      try {
        const { base, email } = await redeemInvite(url.searchParams.get('token'), url.searchParams.get('relay'));
        console.log(`paired with ${base} as ${email}`);
        if (wantsHtml) res.writeHead(302, { location: '/' }).end();
        else res.writeHead(200, { 'content-type': 'text/plain' }).end(`paired with ${base} as ${email}\n`);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`${e.message}\n`);
      }
      return;
    }

    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = join(WEB_ROOT, path);
    if (!file.startsWith(WEB_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache', // dev: otherwise browsers stick to the old app.js
    });
    res.end(await readFile(file));
  } catch (e) {
    console.error('http error:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

// The host must stay alive at all times: we log any unexpected errors instead of crashing.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
// ws re-emits the httpServer's errors on itself; without a listener that kills the process
// before our listen retry below can kick in (verified in experiments/listen-retry-min.mjs)
wss.on('error', () => {});
/** A single initialization path for clients — both local WS and tunnelled through the relay. */
function initClient(ws) {
  clients.add(ws);
  if (ws.guest) {
    send(ws, guestState(ws.guest)); // guests get only their chats, without limits or permissions
    return;
  }
  send(ws, stateSnapshot());
  if (lastLimits) send(ws, { type: 'limits', limits: lastLimits });
  refreshLimits();
  // still-open permission requests go to the new client as well
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

/** The single dispatcher for incoming messages. */
function dispatch(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
    if (ws.guest) {
      if (!GUEST_TYPES.has(msg.type)) throw new Error('only the host owner can do that');
      if (msg.chatId && !guestChatIds(ws.guest).has(msg.chatId)) throw new Error('no access to this chat');
    }
    // async handlers must deliver their errors to the client too
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

// Listen retry: during a self-restart the new copy waits until the old one releases the port.
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
