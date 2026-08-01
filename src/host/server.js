// The host agent's local server: the web UI's static files + the WebSocket protocol.
// It only listens on 127.0.0.1 — we reach the outside world through the relay (see README).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  watchFile,
  unwatchFile,
} from 'node:fs';
import { homedir, userInfo, hostname } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { HostAgent } from './agent.js';
import {
  listSessions,
  loadHistory,
  sessionFile,
  mapEntry,
  listAllSessionFiles,
  searchSessionFile,
  slugFor,
  collectImages,
  isSessionId,
} from './transcripts.js';
import { RelayLink } from './relay-link.js';
import {
  sidecarPath,
  isSidecarPath,
  docPathOfSidecar,
  loadThreads,
  saveThreads,
  makeReply,
  seenFor,
  markThreadSeen,
  unseenThreadIds,
} from './comments.js';

// Port and config are overridable so a second instance can be started safely
// (tests, or a throwaway host) without touching the real one's state.
const PORT = Number(process.env.REMAUDE_PORT ?? 7699);
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CONFIG_PATH = process.env.REMAUDE_CONFIG ?? join(homedir(), '.remaude', 'host.json');

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
const tails = new Map(); // chatId -> {file, offset, restBuf, seen, ownTexts, listener}

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
      // every resume (a host restart included) mints a fresh session id; the old
      // ones are remembered so an old transcript never opens as a second chat
      pastIds: [...(c.pastIds ?? [])].slice(-20),
      title: c.title ?? null,
      permissionMode: c.permissionMode,
    }));
  saveConfig(config);
}

/** The shared path for opening a saved session (open_session and the auto-restore at startup). */
function openSavedSession(projectPath, sessionId, { permissionMode, title, pastIds } = {}) {
  if (!isSessionId(sessionId)) throw new Error('bad session id');
  for (const chat of agent.allChats()) {
    if (chat.sessionId === sessionId || chat.resumeId === sessionId || chat.pastIds?.has(sessionId)) return chat;
  }
  const abs = resolve(projectPath);
  const chat = agent.createChat(abs, { resume: sessionId, permissionMode });
  chat.resumeId = sessionId;
  chat.pastIds = new Set(pastIds ?? []);
  chat.title = title ?? null;
  chatHistories.set(chat.id, loadHistory(abs, sessionId, { defaultAuthor: userName }));
  startTail(chat);
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
  // a service turn (comment thread, chat naming): tag everything it says so the feed can hide it
  const serviceTurn = serviceTurns.get(chatId);
  if (serviceTurn && !serviceTurn.contested) msg.threadRef = serviceTurn.threadId ?? '@service';
  // We broadcast user input ourselves in handleSend (otherwise it duplicates with the SDK's
  // replay), so plain text user messages of the main dialogue are skipped here.
  if (msg.type === 'user' && msg.parent_tool_use_id === null && !hasToolResult(msg)) return;
  // replies to harness continuations ("No response requested.") are noise in a
  // chat feed — filtered here as well as in the transcript reader
  if (msg.type === 'assistant' && msg.parent_tool_use_id === null && isHarnessNoise(msg)) return;
  if (msg.type !== 'stream_event') pushHistory(chatId, msg);
  if (msg.type === 'assistant' || msg.type === 'user') trackAgents(chatId, msg);
  broadcast({ type: 'chat_message', chatId, msg });
  if (msg.type === 'system' && msg.subtype === 'init') {
    // the id this chat was resumed from joins its chain of past identities
    const inited = findChatSafe(chatId);
    if (inited) {
      inited.pastIds ??= new Set();
      if (inited.resumeId) inited.pastIds.add(inited.resumeId);
      inited.pastIds.delete(inited.sessionId);
    }
    sendChatMeta(chatId);
    saveOpenChats(); // the sessionId is now known — record it so we can reopen the chat
    try {
      startTail(findChat(chatId)); // follow foreign writes to the shared transcript
    } catch {
      /* the chat may already be gone */
    }
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
    // the service turn's text has to be captured while lastReplies still holds it
    finishServiceTurn(chatId);
    // The turn is over: a foreground agent that never reported back is gone.
    // Background ones outlive the turn by design — they keep their row.
    let aborted = false;
    for (const agent of agentsOf(chatId).values())
      if (!agent.async && finishAgent(chatId, agent.id, 'aborted')) aborted = true;
    if (aborted) broadcastAgents(chatId);
    refreshLimits(true);
    sendChatMeta(chatId);
    // nobody has this chat on screen — worth buzzing the phone. Merely having a
    // tab open elsewhere must not silence it, or the push never fires at all.
    // a guest reading the chat must not silence the owner's own phone
    if (![...clients].some((c) => !c.guest && c.watching === chatId)) {
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

// ---------- inbox of documents written for the user ----------
// Marked files (a `<!-- remaude -->` first line) and anything under .remaude/
// are indexed as they are written, so nothing has to be scanned later. The
// index keeps paths only — content is always read from disk, since the file
// may have changed or moved on since.

const ARTIFACTS_PATH = join(homedir(), '.remaude', 'artifacts.json');
const INBOX_MARKER = '<!-- remaude -->';

function loadArtifacts() {
  try {
    return JSON.parse(readFileSync(ARTIFACTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}
let artifacts = loadArtifacts();

function saveArtifacts() {
  mkdirSync(dirname(ARTIFACTS_PATH), { recursive: true });
  writeFile(ARTIFACTS_PATH, JSON.stringify(artifacts, null, 2)).catch(() => {});
}

function isInboxPath(p) {
  return /[\\/]\.remaude[\\/]/.test(p);
}

/** First heading or first non-empty line — a human label for the list. */
function docTitle(file) {
  try {
    const head = readFileSync(file, 'utf-8').slice(0, 2000).split('\n');
    for (const line of head) {
      const text = line.replace(INBOX_MARKER, '').trim();
      if (!text) continue;
      return text.replace(/^#+\s*/, '').slice(0, 80);
    }
  } catch {
    /* unreadable — fall back to the file name */
  }
  return null;
}

function rememberArtifact(path, chatId) {
  const abs = resolve(path);
  const chat = findChatSafe(chatId);
  const existing = artifacts.find((a) => a.path.toLowerCase() === abs.toLowerCase());
  const entry = {
    path: abs,
    chatId,
    sessionId: chat?.sessionId ?? chat?.resumeId ?? null,
    projectPath: chat?.cwd ?? null,
    title: docTitle(abs),
    addedAt: existing?.addedAt ?? Date.now(),
  };
  if (existing) Object.assign(existing, entry);
  else artifacts.push(entry);
  saveArtifacts();
  broadcast({ type: 'artifact_added', artifact: entry });
}

/** A Write/Edit landed: index it when the file marks itself as the user's. */
function trackArtifact(chatId, filePath) {
  const abs = resolve(filePath);
  // a comments sidecar was (re)written — that is a comments change, not a new document
  if (isSidecarPath(abs)) {
    broadcastComments(docPathOfSidecar(abs));
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return;
  if (!isInboxPath(abs)) {
    try {
      if (!readFileSync(abs, 'utf-8').slice(0, 200).includes(INBOX_MARKER)) return;
    } catch {
      return;
    }
  }
  rememberArtifact(abs, chatId);
}

// ---------- inline comments on documents ----------
// Threads live in a sidecar next to the .md (see comments.js). The server is a
// thin gate: it checks access, stamps authorship, keeps per-person read marks
// and tells every open client when something changed. Payloads are personal
// (each person has their own read marks), so updates are per-client sends, not
// one shared broadcast.

function identityOf(ws) {
  return ws.guest ? ws.guest.email : '@owner';
}

function authorNameOf(ws) {
  return ws.guest ? ws.guest.email.split('@')[0] : userName;
}

function artifactByPath(path) {
  const abs = resolve(String(path ?? ''));
  return artifacts.find((a) => a.path.toLowerCase() === abs.toLowerCase()) ?? null;
}

/** Comments hang off inbox documents only — and only markdown opens in the viewer. */
function requireDoc(path) {
  const a = artifactByPath(path);
  if (!a) throw new Error('not in the inbox');
  if (!a.path.toLowerCase().endsWith('.md')) throw new Error('comments only work on markdown documents');
  return a;
}

/** May this guest see this document at all? Mirrors the share grants. */
function guestCanSeeDoc(guest, a) {
  const email = guest.email;
  if (hasHostAccess(email)) return true;
  if (a.projectPath && projectSharedWith(a.projectPath, email)) return true;
  if (a.sessionId && (config.shares?.[a.sessionId] ?? []).includes(email)) return true;
  if (a.chatId && guestChatIds(guest).has(a.chatId)) return true;
  return false;
}

function commentsPayload(ws, docPath) {
  const identity = identityOf(ws);
  return {
    type: 'comments',
    path: resolve(docPath),
    threads: loadThreads(docPath),
    seen: seenFor(identity, docPath),
    me: identity,
  };
}

/** Unread counts per document — what lights the red dots in the inbox. */
function badgePayload(ws) {
  const identity = identityOf(ws);
  const perDoc = {};
  let total = 0;
  for (const a of artifacts) {
    if (!a.path.toLowerCase().endsWith('.md')) continue;
    if (ws.guest && !guestCanSeeDoc(ws.guest, a)) continue;
    const n = unseenThreadIds(identity, a.path, loadThreads(a.path)).length;
    if (n) {
      perDoc[a.path] = n;
      total += n;
    }
  }
  return { type: 'comments_badge', total, perDoc };
}

/** A document's comments changed: refresh threads and badges for everyone allowed to look. */
function broadcastComments(docPath) {
  const a = artifactByPath(docPath);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.guest && (!a || !guestCanSeeDoc(ws.guest, a))) continue;
    send(ws, commentsPayload(ws, docPath));
    send(ws, badgePayload(ws));
  }
}

// A service turn: the chat is currently answering something that is not part
// of the conversation — a comment thread, or a request to name the chat. Its
// messages are tagged so the web feed keeps them out of view, and its final
// text is consumed by finishServiceTurn. 'contested' flips when a human
// message interleaves — from then on the turn is a normal visible one.
const serviceTurns = new Map(); // chatId -> {kind: 'thread'|'title', threadId?, path?, askAt, contested}

/** The chat a document belongs to — reopened from its session if it was closed. */
function chatForArtifact(a) {
  let chat = a.chatId ? findChatSafe(a.chatId) : null;
  if (!chat && a.sessionId)
    for (const c of agent.allChats())
      if (c.sessionId === a.sessionId || c.resumeId === a.sessionId) {
        chat = c;
        break;
      }
  if (!chat && a.sessionId && a.projectPath) {
    chat = openSavedSession(a.projectPath, a.sessionId, {});
    saveOpenChats();
    broadcast(stateSnapshot());
  }
  if (!chat) throw new Error('the document has no chat to ask in');
  return chat;
}

function threadPrompt(a, thread, question) {
  const replies = (thread.replies ?? []).map((r) => `${r.author}: ${r.text}`).join('\n\n');
  return [
    '[remaude: a question from an inline-comment thread — hidden from the chat feed]',
    `The document ${a.path} has a comment thread on this fragment:`,
    '"""',
    thread.anchor?.quote || '(the fragment could not be quoted)',
    '"""',
    'The thread so far:',
    replies || '(no replies yet)',
    '',
    question ? `The new question: ${question}` : 'Reply to the thread above.',
    '',
    'Answer in ONE message, in the language of the thread. Your final text is added to the thread automatically — do not edit the comments sidecar file yourself. Start your reply with the exact line `[remaude: thread reply]` (it is stripped before posting), then the reply itself. Read the document or the code first if that makes the answer better.',
  ].join('\n');
}

/** The service turn is over: its final text becomes a thread reply or the chat's name. */
function finishServiceTurn(chatId) {
  const turn = serviceTurns.get(chatId);
  if (!turn) return;
  serviceTurns.delete(chatId);
  const finalText = (lastReplies.get(chatId) ?? '').replace(/^\s*\[remaude[^\]]*\]\s*/, '').trim();
  try {
    if (turn.kind === 'title') {
      // a contested turn answered the human, not the naming request — drop it
      if (turn.contested || !finalText) return;
      const title = finalText.split('\n')[0].replace(/^["'«»„“”]+|["'«»„“”]+$/g, '').trim().slice(0, 60);
      const chat = findChatSafe(chatId);
      if (!chat || !title) return;
      chat.title = title;
      saveOpenChats();
      broadcast(stateSnapshot());
      return;
    }
    const threads = loadThreads(turn.path);
    const thread = threads.find((t) => t.id === turn.threadId);
    if (thread && finalText && !thread.replies.some((r) => r.role === 'assistant' && r.createdAt >= turn.askAt)) {
      thread.replies.push(makeReply({ author: 'Claude', authorId: '@llm', role: 'assistant', text: finalText }));
      saveThreads(turn.path, threads);
    }
    const a = artifactByPath(turn.path);
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.guest && (!a || !guestCanSeeDoc(ws.guest, a))) continue;
      send(ws, { type: 'llm_thread_done', path: turn.path, threadId: turn.threadId });
    }
    broadcastComments(turn.path);
  } catch (e) {
    console.error('service turn failed:', e.message);
  }
}

// ---------- subagent tracking ----------
// An Agent tool_use starts one; the matching tool_result ends it; anything still
// running when the turn ends was aborted. The sidebar shows these live, so the
// bookkeeping lives here rather than being guessed at from the feed.

// Parsed images per transcript, so paging a gallery does not re-read a
// multi-megabyte file for every thumbnail. Dropped when the file changes.
const imageCache = new Map(); // file -> {mtime, images}

function cachedImages(file) {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const hit = imageCache.get(file);
  if (hit && hit.mtime === mtime) return hit.images;
  const images = collectImages(file);
  imageCache.set(file, { mtime, images });
  if (imageCache.size > 8) imageCache.delete(imageCache.keys().next().value);
  return images;
}

const pendingWrites = new Map(); // toolUseId -> file path, until the write reports back
const chatAgents = new Map(); // chatId -> Map(toolUseId -> {id, label, type, status, startedAt, endedAt})
const AGENT_LINGER_MS = 30_000; // how long a finished agent stays visible

function agentsOf(chatId) {
  if (!chatAgents.has(chatId)) chatAgents.set(chatId, new Map());
  return chatAgents.get(chatId);
}

function broadcastAgents(chatId) {
  const list = [...agentsOf(chatId).values()].map((a) => ({
    id: a.id,
    label: a.label,
    type: a.type,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt ?? null,
  }));
  broadcast({ type: 'agents', chatId, agents: list });
}

function finishAgent(chatId, id, status) {
  const agent = agentsOf(chatId).get(id);
  if (!agent || agent.status !== 'running') return false;
  agent.status = status;
  agent.endedAt = Date.now();
  setTimeout(() => {
    agentsOf(chatId).delete(id);
    broadcastAgents(chatId);
  }, AGENT_LINGER_MS).unref?.();
  return true;
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

function trackAgents(chatId, msg) {
  let changed = false;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
    for (const block of content) {
      if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit') && block.input?.file_path)
        pendingWrites.set(block.id, block.input.file_path);
      if (block.type !== 'tool_use' || block.name !== 'Agent') continue;
      agentsOf(chatId).set(block.id, {
        id: block.id,
        label: block.input?.description ?? block.input?.prompt?.slice(0, 60) ?? 'agent',
        type: block.input?.subagent_type ?? null,
        status: 'running',
        startedAt: Date.now(),
      });
      changed = true;
    }
  }

  if (msg.type === 'user') {
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      // a write finished: the file exists now, so its marker can be read
      const written = pendingWrites.get(block.tool_use_id);
      if (written) {
        pendingWrites.delete(block.tool_use_id);
        if (!block.is_error) trackArtifact(chatId, written);
      }
      const agent = agentsOf(chatId).get(block.tool_use_id);
      if (!agent) continue;
      // A background agent answers twice on the same tool_use_id: first
      // "launched" with its id, then the real report minutes later. Only the
      // second one means it is done — the first used to hide the row instantly.
      const text = resultText(block);
      if (text.slice(0, 200).toLowerCase().includes('async agent launched')) {
        agent.async = true;
        // remember the id the harness will name it by when it finishes
        agent.agentId = /agentid:\s*([0-9a-z]+)/i.exec(text)?.[1] ?? null;
        changed = true;
        continue;
      }
      if (finishAgent(chatId, block.tool_use_id, block.is_error ? 'failed' : 'done')) changed = true;
    }
  }

  // A background agent's completion does not always come back as a tool_result
  // on the original id — the harness may only announce it by agent id. Anything
  // naming a running agent's id counts as its report, or the row runs forever.
  if (msg.type === 'user') {
    const blob = JSON.stringify(content);
    for (const agent of agentsOf(chatId).values()) {
      if (agent.status !== 'running' || !agent.agentId) continue;
      if (blob.includes(agent.agentId) && finishAgent(chatId, agent.id, 'done')) changed = true;
    }
  }

  if (changed) broadcastAgents(chatId);
}

/** The harness's stand-in for "this turn needs no answer". */
function isHarnessNoise(msg) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text === 'No response requested.';
}

function hasToolResult(msg) {
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'tool_result');
}

function pushHistory(chatId, msg) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  chatHistories.get(chatId).push(msg);
  if (msg.uuid) tails.get(chatId)?.seen.add(msg.uuid);
}

// ---------- transcript sync: two frontends, one shared log ----------
// The SDK does not replay foreign writes into our stream, so while a chat is
// open here, another process (VS Code) may keep appending to the same session
// file. We tail that file: entries we did not produce are mapped and pushed
// into the feed live. Ours are skipped by uuid; typed input, which has no uuid
// on our side, is matched by its text.

// (declared with the other state above — startup reopens chats before this point)

function startTail(chat) {
  if (tails.has(chat.id)) return;
  const sid = chat.sessionId ?? chat.resumeId;
  if (!sid) return;
  const file = sessionFile(chat.cwd, sid);
  if (!file) return;
  const tail = {
    file,
    offset: statSync(file).size,
    restBuf: Buffer.alloc(0),
    seen: new Set((chatHistories.get(chat.id) ?? []).map((m) => m.uuid).filter(Boolean)),
    ownTexts: [],
    listener: () => {
      try {
        drainTail(chat.id, tail);
      } catch (e) {
        console.error('tail error:', e.message);
      }
    },
  };
  watchFile(file, { interval: 1500 }, tail.listener);
  tails.set(chat.id, tail);
}

function stopTail(chatId) {
  const tail = tails.get(chatId);
  if (!tail) return;
  unwatchFile(tail.file, tail.listener);
  tails.delete(chatId);
}

function drainTail(chatId, tail) {
  let size;
  try {
    size = statSync(tail.file).size;
  } catch {
    return; // the file may briefly vanish on rotation
  }
  if (size < tail.offset) {
    tail.offset = size; // truncated — start following from the new end
    tail.restBuf = Buffer.alloc(0);
    return;
  }
  if (size === tail.offset) return;

  const chunk = Buffer.alloc(Math.min(size - tail.offset, 8 * 1024 * 1024));
  const fd = openSync(tail.file, 'r');
  let read;
  try {
    read = readSync(fd, chunk, 0, chunk.length, tail.offset);
  } finally {
    closeSync(fd);
  }
  tail.offset += read;

  // split on the last newline so multi-byte characters never get cut mid-sequence
  const data = Buffer.concat([tail.restBuf, chunk.subarray(0, read)]);
  const lastNl = data.lastIndexOf(0x0a);
  if (lastNl === -1) {
    tail.restBuf = data;
    return;
  }
  tail.restBuf = Buffer.from(data.subarray(lastNl + 1));

  for (const line of data.subarray(0, lastNl).toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.uuid && tail.seen.has(entry.uuid)) continue;
    const msg = mapEntry(entry, { defaultAuthor: userName });
    if (entry.uuid) tail.seen.add(entry.uuid);
    if (!msg) continue;
    // our own typed input reaches the transcript under a uuid we never saw — match by text
    if (msg.type === 'user' && !msg.parent_tool_use_id) {
      const text =
        typeof msg.message.content === 'string'
          ? msg.message.content
          : msg.message.content?.find?.((b) => b.type === 'text')?.text;
      const i = tail.ownTexts.indexOf(text);
      if (i !== -1) {
        tail.ownTexts.splice(i, 1);
        continue;
      }
    }
    pushHistory(chatId, msg);
    // the same bookkeeping as the live stream: a completion we only see on disk
    // still has to close the agent's row
    if (msg.type === 'assistant' || msg.type === 'user') trackAgents(chatId, msg);
    broadcast({ type: 'chat_message', chatId, msg });
  }
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

// ---------- who may see what ----------
// Access is granted at three levels and simply adds up: a single chat, a whole
// project (its future chats included), or the entire host. The relay only needs
// to know *whether* someone has any access — which chats they see is decided
// here, where the grants live.

function shareGrants() {
  return {
    chats: config.shares ?? {}, // sessionId -> [email]
    projects: config.projectShares ?? {}, // projectPath -> [email]
    host: config.hostShares ?? [],
  };
}

function allSharedEmails() {
  const g = shareGrants();
  return [...new Set([...Object.values(g.chats).flat(), ...Object.values(g.projects).flat(), ...g.host])];
}

function announceShares() {
  relayLink?.setShares(allSharedEmails());
}

function hasHostAccess(email) {
  return (config.hostShares ?? []).includes(email);
}

function projectSharedWith(projectPath, email) {
  const list = config.projectShares?.[resolve(projectPath)] ?? [];
  return list.includes(email);
}

/** ids of the live chats available to a guest */
function guestChatIds(guest) {
  const email = guest.email;
  const ids = new Set();
  for (const project of agent.projects.values()) {
    const wholeProject = hasHostAccess(email) || projectSharedWith(project.path, email);
    for (const chat of project.chats.values()) {
      const sid = chat.sessionId ?? chat.resumeId;
      if (wholeProject || (sid && (config.shares?.[sid] ?? []).includes(email))) ids.add(chat.id);
    }
  }
  return ids;
}

function shareKeyForChat(chatId) {
  const chat = findChat(chatId);
  const sid = chat.sessionId ?? chat.resumeId;
  if (!sid) throw new Error('this chat has no session id yet — send at least one message into it');
  return sid;
}

/** The email list behind a scope; `create` makes it exist. */
function shareListFor({ chatId, projectPath, host }, create) {
  if (host) {
    if (create) config.hostShares ??= [];
    return config.hostShares ?? null;
  }
  if (projectPath) {
    const abs = resolve(projectPath);
    if (create) (config.projectShares ??= {})[abs] ??= [];
    return config.projectShares?.[abs] ?? null;
  }
  const sid = shareKeyForChat(chatId);
  if (create) (config.shares ??= {})[sid] ??= [];
  return config.shares?.[sid] ?? null;
}

function currentShare(scope) {
  let emails = [];
  try {
    emails = shareListFor(scope, false) ?? [];
  } catch {
    emails = []; // a chat with no session id yet simply has no shares
  }
  return { ...scope, emails };
}

/** Projects a guest may start new chats in (never new projects). */
function guestProjectPaths(guest) {
  const email = guest.email;
  return [...agent.projects.keys()].filter((p) => hasHostAccess(email) || projectSharedWith(p, email));
}

function guestState(guest) {
  const allowed = guestChatIds(guest);
  const openable = new Set(guestProjectPaths(guest));
  const snapshot = stateSnapshot();
  return {
    ...snapshot,
    guest: true,
    projects: snapshot.projects
      .map((p) => ({ ...p, chats: p.chats.filter((c) => allowed.has(c.id)), canCreate: openable.has(p.path) }))
      // a shared project stays visible even with no chats yet — the guest may start one
      .filter((p) => p.chats.length || openable.has(p.path)),
  };
}

/** Which of the broadcasts a guest gets to see. */
function guestCanSee(guest, obj) {
  if (obj.type === 'chat_message' || obj.type === 'chat_status' || obj.type === 'chat_meta' || obj.type === 'chat_error')
    return guestChatIds(guest).has(obj.chatId);
  return false; // state is handled separately; permissions/limits/relay — owner only
}

/** Commands that address a document by path — each checked against the share grants. */
const DOC_TYPES = new Set([
  'read_artifact',
  'list_comments',
  'add_comment',
  'reply_comment',
  'edit_comment',
  'delete_comment',
  'resolve_comment',
  'mark_thread_seen',
  'ask_llm_comment',
]);

/** The commands allowed to guests (and only on their own chats). */
const GUEST_TYPES = new Set([
  'send',
  'history',
  'focus',
  'create_chat',
  'list_sessions',
  'open_session',
  'attachments',
  'image',
  'tool_result',
  ...DOC_TYPES, // documents and their comment threads — gated per document in dispatch()
]);

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
      name: config.projectNames?.[p.path] ?? null,
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
        stopTail(chat.id);
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

  send(ws, { chatId, content, localId }) {
    const chat = findChat(chatId);
    ws.watching = chatId; // whoever is typing here is plainly watching it
    // a human message lands mid-service-turn: the turn is a shared one now, so
    // stop hiding it (a thread answer still gets copied; a title is dropped)
    const serviceTurn = serviceTurns.get(chatId);
    if (serviceTurn) serviceTurn.contested = true;
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
      localId, // lets the sender skip the echo of the bubble it already drew
    };
    pushHistory(chatId, userMsg);
    broadcast({ type: 'chat_message', chatId, msg: userMsg });
    // the transcript will echo this input under a fresh uuid — let the tail skip it
    const tail = tails.get(chatId);
    if (tail) {
      const ownText = typeof content === 'string' ? content : content.find?.((b) => b.type === 'text')?.text;
      tail.ownTexts.push(ownText);
      if (tail.ownTexts.length > 20) tail.ownTexts.shift();
    }
  },

  /** The project's sessions saved on disk (including ones created in VS Code/the CLI). */
  list_sessions(ws, { projectPath }) {
    const abs = resolve(projectPath);
    const live = {};
    // only this project's live chats: the map used to name every session on the
    // machine, which told a guest what else exists here
    for (const chat of agent.projects.get(abs)?.chats.values() ?? []) {
      if (chat.sessionId) live[chat.sessionId] = chat.id;
      if (chat.resumeId) live[chat.resumeId] = chat.id;
      for (const id of chat.pastIds ?? []) live[id] = chat.id; // old links in the chain are this same chat
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
    // The full log with inline screenshots is tens of megabytes through the
    // relay tunnel — that was the ~10s cold open. The feed gets the recent
    // tail; in all but the freshest messages images collapse to placeholders
    // (the gallery still serves the real ones) and huge payloads are clipped.
    const all = chatHistories.get(chatId) ?? [];
    const tail = all.slice(-300);
    const keepRich = tail.length - 30;
    send(ws, { type: 'history', chatId, messages: tail.map((m, i) => lazyHistoryMessage(m, i < keepRich)) });
  },

  /** One tool result on demand — the history only carried its stub. */
  tool_result(ws, { chatId, toolUseId }) {
    for (const msg of chatHistories.get(chatId) ?? []) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      const block = content.find((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (block) {
        send(ws, { type: 'tool_result_data', chatId, toolUseId, block });
        return;
      }
    }
    throw new Error('no such tool result');
  },

  get_limits() {
    refreshLimits(true);
  },

  /** Which chat this client is looking at right now (null when hidden). */
  focus(ws, { chatId }) {
    ws.watching = chatId ?? null;
  },

  /** Who this chat / project / host is shared with right now. */
  list_shares(ws, { chatId, projectPath, host }) {
    send(ws, { type: 'share_result', ...currentShare({ chatId, projectPath, host }) });
  },

  /** Grant access at whichever level was asked for. */
  share_scope(ws, { chatId, projectPath, host, email }) {
    const clean = String(email).trim().toLowerCase();
    if (!clean.includes('@')) throw new Error('that does not look like an email');
    const list = shareListFor({ chatId, projectPath, host }, true);
    if (!list.includes(clean)) list.push(clean);
    saveConfig(config);
    announceShares();
    broadcast(stateSnapshot()); // guests may have just gained a project
    send(ws, { type: 'share_result', ...currentShare({ chatId, projectPath, host }) });
  },

  unshare_scope(ws, { chatId, projectPath, host, email }) {
    const clean = String(email ?? '').trim().toLowerCase();
    const list = shareListFor({ chatId, projectPath, host }, false);
    if (list) {
      const kept = clean ? list.filter((e) => e !== clean) : [];
      if (host) config.hostShares = kept;
      else if (projectPath) config.projectShares[resolve(projectPath)] = kept;
      else config.shares[shareKeyForChat(chatId)] = kept;
      saveConfig(config);
      announceShares();
      broadcast(stateSnapshot());
    }
    send(ws, { type: 'share_result', ...currentShare({ chatId, projectPath, host }) });
  },

  /**
   * Full-text search over saved transcripts, one page at a time so a deep dig
   * stays possible without ever scanning gigabytes up front. Files are visited
   * in the order the user cares about: the chat they are in, then the projects
   * on screen, then everything else this machine has ever recorded.
   */
  search(ws, { query, more }) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle.length < 2) {
      send(ws, { type: 'search_results', query, results: [], hasMore: false, done: true });
      return;
    }

    if (!more || searchCursor?.needle !== needle) {
      const openSlugs = [...agent.projects.keys()].map((p) => slugFor(p));
      const currentSlug = ws.watching ? slugFor(findChatSafe(ws.watching)?.cwd ?? '') : null;
      const rank = (slug) => (slug === currentSlug ? 0 : openSlugs.includes(slug) ? 1 : 2);
      const files = listAllSessionFiles().sort((a, b) => rank(a.slug) - rank(b.slug) || b.mtime - a.mtime);
      searchCursor = { needle, files, idx: 0 };
    }

    const cursor = searchCursor;
    const results = [];
    const deadline = Date.now() + 2500; // a page must not hang the sidebar
    while (cursor.idx < cursor.files.length && results.length < 8 && Date.now() < deadline) {
      const entry = cursor.files[cursor.idx++];
      const hit = searchSessionFile(entry.file, needle);
      if (!hit) continue;
      results.push({
        sessionId: entry.id,
        projectPath: hit.cwd,
        title: hit.title,
        snippet: hit.snippet,
        matches: hit.matches,
        mtime: entry.mtime,
      });
    }
    send(ws, {
      type: 'search_results',
      query,
      results,
      hasMore: cursor.idx < cursor.files.length,
      scanned: cursor.idx,
      total: cursor.files.length,
    });
  },

  /**
   * The attachments panel: pictures pulled straight out of the transcripts and
   * documents from the inbox index. Scope is one chat or a whole project.
   */
  attachments(ws, { chatId, scope = 'chat', offset = 0, limit = 24 }) {
    const chat = findChat(chatId);
    const project = resolve(chat.cwd);
    const sessions =
      scope === 'project'
        ? listSessions(project).map((s) => s.id)
        : [chat.sessionId ?? chat.resumeId].filter(Boolean);

    // Metadata only: a page of two dozen full-size screenshots is tens of
    // megabytes, which is exactly what gets a phone's web app killed. The
    // pictures themselves are fetched one at a time, as they scroll into view.
    let images = [];
    for (const sid of sessions) {
      const file = sessionFile(project, sid);
      if (file)
        images.push(
          ...cachedImages(file).map((img, index) => ({
            sessionId: sid,
            index,
            ts: img.ts,
            mine: img.mine,
            mediaType: img.mediaType,
          }))
        );
    }
    images.sort((a, b) => new Date(b.ts ?? 0) - new Date(a.ts ?? 0));
    const page = images.slice(offset, offset + limit);

    // A resumed session gets a fresh id, so a document written before a host
    // restart no longer matches by sessionId alone — the chain goes through
    // resumeId. A match through the old id also heals the entry in place, so
    // it survives the next restart too.
    const inThisChat = (a) => {
      if (a.chatId === chatId || (a.sessionId && a.sessionId === chat.sessionId)) return true;
      if (!a.sessionId || a.sessionId !== chat.resumeId) return false;
      a.chatId = chatId;
      if (chat.sessionId) a.sessionId = chat.sessionId;
      saveArtifacts();
      return true;
    };
    const docs = artifacts
      .filter((a) => (scope === 'project' ? resolve(a.projectPath ?? '') === project : inThisChat(a)))
      .map((a) => {
        let size = null;
        let missing = true;
        try {
          const st = statSync(a.path);
          size = st.size;
          missing = false;
        } catch {
          /* the file is gone — say so rather than pretend */
        }
        return { ...a, size, missing, name: a.path.split(/[\\/]/).pop() };
      })
      .sort((a, b) => b.addedAt - a.addedAt);

    send(ws, {
      type: 'attachments',
      chatId,
      scope,
      images: page,
      imagesTotal: images.length,
      offset,
      docs: offset ? [] : docs, // docs come with the first page only
    });
  },

  /** One picture out of a transcript, by the index the metadata carried. */
  image(ws, { chatId, sessionId, index }) {
    const project = resolve(findChat(chatId).cwd);
    const file = sessionFile(project, sessionId);
    if (!file) throw new Error('no such session'); // also rejects ids shaped like paths
    const img = cachedImages(file)[index];
    if (!img) throw new Error('no such image');
    send(ws, { type: 'image_data', sessionId, index, mediaType: img.mediaType, data: img.data });
  },

  /** Read a document for the in-app viewer (markdown) or for downloading. */
  read_artifact(ws, { path, asText = true }) {
    const abs = resolve(path);
    if (!artifacts.some((a) => a.path.toLowerCase() === abs.toLowerCase())) throw new Error('not in the inbox');
    const buf = readFileSync(abs);
    if (buf.length > 12 * 1024 * 1024) throw new Error('file too large to send');
    send(ws, {
      type: 'artifact',
      path: abs,
      name: abs.split(/[\\/]/).pop(),
      text: asText ? buf.toString('utf-8') : null,
      base64: asText ? null : buf.toString('base64'),
    });
  },

  /** Manual "add to inbox" for a file that was written without a marker. */
  add_artifact(ws, { path, chatId }) {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('no such file');
    rememberArtifact(abs, chatId);
  },

  remove_artifact(ws, { path }) {
    const abs = resolve(path).toLowerCase();
    artifacts = artifacts.filter((a) => a.path.toLowerCase() !== abs);
    saveArtifacts();
    broadcast({ type: 'artifact_removed', path: abs });
  },

  // ---------- inline comments ----------

  list_comments(ws, { path }) {
    const a = requireDoc(path);
    send(ws, commentsPayload(ws, a.path));
    send(ws, badgePayload(ws));
  },

  /** A new thread: the selection anchor plus its first reply. */
  add_comment(ws, { path, anchor, text }) {
    const a = requireDoc(path);
    const body = String(text ?? '').trim();
    if (!body) throw new Error('empty comment');
    const threads = loadThreads(a.path);
    const thread = {
      id: randomUUID(),
      anchor: {
        quote: String(anchor?.quote ?? '').slice(0, 2000),
        prefix: String(anchor?.prefix ?? '').slice(0, 200),
        suffix: String(anchor?.suffix ?? '').slice(0, 200),
      },
      resolved: false,
      createdAt: Date.now(),
      replies: [makeReply({ author: authorNameOf(ws), authorId: identityOf(ws), text: body })],
    };
    threads.push(thread);
    saveThreads(a.path, threads);
    markThreadSeen(identityOf(ws), a.path, thread.id); // your own comment is not news to you
    broadcastComments(a.path);
  },

  reply_comment(ws, { path, threadId, text }) {
    const a = requireDoc(path);
    const body = String(text ?? '').trim();
    if (!body) throw new Error('empty reply');
    const threads = loadThreads(a.path);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('no such thread');
    thread.replies.push(makeReply({ author: authorNameOf(ws), authorId: identityOf(ws), text: body }));
    saveThreads(a.path, threads);
    markThreadSeen(identityOf(ws), a.path, threadId);
    broadcastComments(a.path);
  },

  /** Only the author edits their reply — the owner included (own replies only). */
  edit_comment(ws, { path, threadId, replyId, text }) {
    const a = requireDoc(path);
    const body = String(text ?? '').trim();
    if (!body) throw new Error('empty reply');
    const threads = loadThreads(a.path);
    const reply = threads.find((t) => t.id === threadId)?.replies.find((r) => r.id === replyId);
    if (!reply) throw new Error('no such reply');
    if (reply.authorId !== identityOf(ws)) throw new Error('only the author can edit a reply');
    reply.text = String(body).slice(0, 20000);
    reply.editedAt = Date.now();
    saveThreads(a.path, threads);
    broadcastComments(a.path);
  },

  /** The author or the host owner. Deleting the first reply deletes the thread. */
  delete_comment(ws, { path, threadId, replyId }) {
    const a = requireDoc(path);
    const threads = loadThreads(a.path);
    const thread = threads.find((t) => t.id === threadId);
    const reply = thread?.replies.find((r) => r.id === replyId);
    if (!reply) throw new Error('no such reply');
    if (reply.authorId !== identityOf(ws) && ws.guest) throw new Error('only the author or the owner can delete this');
    if (thread.replies[0].id === replyId) threads.splice(threads.indexOf(thread), 1);
    else thread.replies = thread.replies.filter((r) => r.id !== replyId);
    saveThreads(a.path, threads);
    broadcastComments(a.path);
  },

  /** Anyone with access may resolve or reopen — that is the point of a comment. */
  resolve_comment(ws, { path, threadId, resolved }) {
    const a = requireDoc(path);
    const threads = loadThreads(a.path);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('no such thread');
    thread.resolved = Boolean(resolved);
    saveThreads(a.path, threads);
    broadcastComments(a.path);
  },

  /** Read marks are per thread, set when its branch is actually opened. */
  mark_thread_seen(ws, { path, threadId }) {
    const a = requireDoc(path);
    markThreadSeen(identityOf(ws), a.path, threadId);
    // every device of the same person drops its red dot at once
    for (const c of clients) {
      if (c.readyState !== c.OPEN || identityOf(c) !== identityOf(ws)) continue;
      send(c, commentsPayload(c, a.path));
      send(c, badgePayload(c));
    }
  },

  /**
   * Ask the LLM in the thread. The question goes into the document's own chat
   * (full context), the turn is hidden from the feed, and the model's final
   * text comes back as a thread reply — see finishLlmThread.
   */
  ask_llm_comment(ws, { path, threadId, text }) {
    const a = requireDoc(path);
    const threads = loadThreads(a.path);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('no such thread');
    const chat = chatForArtifact(a);
    if (ws.guest && !guestChatIds(ws.guest).has(chat.id)) throw new Error('no access to this chat');
    if (chat.status === 'thinking' || chat.status === 'waiting_permission')
      throw new Error('the document’s chat is busy — wait for its turn to finish and ask again');
    const question = String(text ?? '').trim();
    if (question) {
      thread.replies.push(makeReply({ author: authorNameOf(ws), authorId: identityOf(ws), text: question }));
      saveThreads(a.path, threads);
      markThreadSeen(identityOf(ws), a.path, threadId);
    }
    serviceTurns.set(chat.id, { kind: 'thread', threadId, path: a.path, askAt: Date.now(), contested: false });
    const prompt = threadPrompt(a, thread, question);
    tails.get(chat.id)?.ownTexts.push(prompt); // the transcript echo must not reappear via the tail
    chat.send(prompt);
    broadcastComments(a.path);
  },

  /** Sidebar order of projects: the config array itself is the order. */
  reorder_projects(ws, { paths }) {
    const wanted = paths.map((p) => resolve(p));
    const rest = [...agent.projects.keys()].filter((p) => !wanted.includes(p));
    const ordered = [...wanted.filter((p) => agent.projects.has(p)), ...rest];
    const projects = new Map(ordered.map((p) => [p, agent.projects.get(p)]));
    agent.projects.clear();
    for (const [k, v] of projects) agent.projects.set(k, v);
    config.projects = ordered;
    saveConfig(config);
    broadcast(stateSnapshot());
  },

  /** Sidebar order of chats inside one project. */
  reorder_chats(ws, { projectPath, chatIds }) {
    const project = agent.projects.get(resolve(projectPath));
    if (!project) throw new Error('no such project');
    const rest = [...project.chats.keys()].filter((id) => !chatIds.includes(id));
    const ordered = [...chatIds.filter((id) => project.chats.has(id)), ...rest];
    const chats = new Map(ordered.map((id) => [id, project.chats.get(id)]));
    project.chats.clear();
    for (const [k, v] of chats) project.chats.set(k, v);
    saveOpenChats();
    broadcast(stateSnapshot());
  },

  /** A display alias for a project; the folder on disk keeps its name. */
  rename_project(ws, { path, name }) {
    const abs = resolve(path);
    config.projectNames ??= {};
    if (name?.trim()) config.projectNames[abs] = name.trim().slice(0, 60);
    else delete config.projectNames[abs];
    saveConfig(config);
    broadcast(stateSnapshot());
  },

  rename_chat(ws, { chatId, title }) {
    findChat(chatId).title = String(title).slice(0, 80);
    saveOpenChats();
    broadcast(stateSnapshot());
  },

  /**
   * Name the chat by asking the chat itself — the session already holds the
   * whole conversation in context, so no separate model or digest is needed.
   * The turn is a hidden service one; finishServiceTurn applies the result.
   */
  suggest_title(ws, { chatId }) {
    const chat = findChat(chatId);
    if (chat.status === 'thinking' || chat.status === 'waiting_permission')
      throw new Error('the chat is busy — wait for its turn to finish');
    serviceTurns.set(chat.id, { kind: 'title', askAt: Date.now(), contested: false });
    const prompt = [
      '[remaude: a service request — hidden from the chat feed]',
      'Come up with a name for this chat: short and specific, 40 characters at most,',
      'in the language the user writes in, no surrounding quotes, no trailing period.',
      'Reply with the exact line `[remaude: title]`, then the name on the next line, and nothing else.',
    ].join('\n');
    tails.get(chat.id)?.ownTexts.push(prompt); // the transcript echo must not reappear via the tail
    chat.send(prompt);
  },

  /** Close a chat and remove it from the sidebar; the transcript stays, we resume it via open_session. */
  hide_chat(ws, { chatId }) {
    const chat = findChat(chatId);
    chat.close();
    for (const p of agent.projects.values()) p.chats.delete(chatId);
    chatHistories.delete(chatId);
    stopTail(chatId);
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

let searchCursor = null; // {needle, files, idx} — lets "load more" resume the scan

/**
 * History travels light: every tool result becomes an empty lazy stub that the
 * client fetches on demand (see the tool_result command), and outside the
 * freshest messages inline images collapse to placeholders too (the gallery
 * still serves the real ones).
 */
function lazyHistoryMessage(msg, slimImages) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return msg;
  let changed = false;
  const mapped = content.map((b) => {
    if (b.type === 'tool_result') {
      changed = true;
      return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error ?? false, content: '', lazy: true };
    }
    if (slimImages && b.type === 'image') {
      changed = true;
      return { type: 'text', text: '🖼 (в галерее 📎)' };
    }
    return b;
  });
  return changed ? { ...msg, message: { ...msg.message, content: mapped } } : msg;
}

function findChatSafe(chatId) {
  for (const chat of agent.allChats()) if (chat.id === chatId) return chat;
  return null;
}

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
      // A bare GET here was a one-click hijack: any page could fetch this URL
      // and silently re-pair the machine to an attacker's relay, which then owns
      // it. A browser now has to confirm, and the confirmation is a POST.
      if (wantsHtml && req.method !== 'POST') {
        const relay = url.searchParams.get('relay') ?? config.relay?.url ?? RELAY_DEFAULT_URL;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><meta charset="utf-8"><title>remaude · connect</title>
<style>body{background:#14151a;color:#d8dae4;font:15px/1.6 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:460px;text-align:center;padding:24px}h1{color:#7aa2f7;font-size:20px}b{color:#e0af68}
button{background:#7aa2f7;color:#10141f;border:0;border-radius:8px;padding:11px 24px;font:inherit;font-weight:600;cursor:pointer;margin-top:14px}</style>
<div class="box"><h1>connect this computer?</h1>
<p>It will be linked to <b>${String(relay).replace(/[<>&"]/g, '')}</b>, and whoever controls that address will be able to open chats here.</p>
<p>If you did not just ask for this, close the page.</p>
<form method="post"><button type="submit">Connect</button></form></div>`
        );
        return;
      }
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

/**
 * Any page in the user's browser can open ws://127.0.0.1:7699 — browsers do not
 * apply CORS to WebSockets, and a local socket that trusts everyone is owner
 * rights for whatever site they happen to be reading. Only our own origins are
 * allowed; requests without an Origin header (curl, the test scripts) are not
 * browser-driven and stay allowed.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const { hostname, port } = new URL(origin);
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return local && (port === String(PORT) || port === '');
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: ({ req }) => originAllowed(req),
});
// ws re-emits the httpServer's errors on itself; without a listener that kills the process
// before our listen retry below can kick in (verified in experiments/listen-retry-min.mjs)
wss.on('error', () => {});
/** A single initialization path for clients — both local WS and tunnelled through the relay. */
function initClient(ws) {
  clients.add(ws);
  if (ws.guest) {
    send(ws, guestState(ws.guest)); // guests get only their chats, without limits or permissions
    send(ws, badgePayload(ws)); // unread comment dots work for collaborators too
    return;
  }
  send(ws, stateSnapshot());
  send(ws, badgePayload(ws));
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
  // a fresh client should see agents that are already running
  for (const [chatId, agents] of chatAgents) if (agents.size) broadcastAgents(chatId);
}

/** The single dispatcher for incoming messages. */
function dispatch(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
    if (ws.guest) {
      if (!GUEST_TYPES.has(msg.type)) throw new Error('only the host owner can do that');
      if (msg.chatId && !guestChatIds(ws.guest).has(msg.chatId)) throw new Error('no access to this chat');
      // a guest may start chats in a shared project, but never reach another one
      if (msg.projectPath && !guestProjectPaths(ws.guest).includes(resolve(msg.projectPath)))
        throw new Error('no access to this project');
      // documents are gated one by one: only what the share grants cover
      if (DOC_TYPES.has(msg.type)) {
        const doc = artifactByPath(msg.path);
        if (!doc || !guestCanSeeDoc(ws.guest, doc)) throw new Error('no access to this document');
      }
      // Arguments other than the two ids above decide privileges too. A guest
      // asking for bypassPermissions would get a session that never prompts the
      // owner — that is code execution on this machine, so pin the safe values.
      if (msg.permissionMode) msg.permissionMode = 'default';
      delete msg.model; // and no picking the expensive model on someone else's account
      if (msg.scope === 'project' && !guestProjectPaths(ws.guest).length) msg.scope = 'chat';
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
