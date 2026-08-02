// Threads inside a chat, Slack-style: a reply hangs off one message, and the
// model's answer to it is filed there instead of the main feed. The session
// itself stays linear — a thread is a tag over its messages, nothing more.
import { mdToHtml } from './md.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

let request = () => {}; // wired to the hosts by app.js

// chatId -> { threads: Map(threadId -> {id, anchorUuid, msgs}), anchors: Map(uuid -> text) }
const perChat = new Map();
let open = null; // {chatId, threadId}
let busy = false; // the open thread is waiting for an answer

function stateOf(chatId) {
  if (!perChat.has(chatId)) perChat.set(chatId, { threads: new Map(), anchors: new Map() });
  return perChat.get(chatId);
}

const threadOf = (chatId, threadId) => stateOf(chatId).threads.get(threadId) ?? null;

export function initThreads(ctx) {
  request = ctx.request;
  buildUi();
}

/** A chat is being repainted from history: its threads are refilled from scratch. */
export function resetChat(chatId) {
  const state = stateOf(chatId);
  for (const t of state.threads.values()) t.msgs = [];
  if (open?.chatId === chatId) renderPanel();
}

export function onThreads({ chatId, threads }) {
  const state = stateOf(chatId);
  for (const t of threads) {
    const existing = state.threads.get(t.id);
    if (existing) Object.assign(existing, { anchorUuid: t.anchorUuid, createdAt: t.createdAt });
    else state.threads.set(t.id, { ...t, msgs: [] });
  }
  refreshChips(chatId);
  if (open?.chatId === chatId) renderPanel();
}

/** The panel the server opened for us (after create_thread). */
export function onOpened({ chatId, threadId }) {
  open = { chatId, threadId };
  busy = false;
  renderPanel();
  $('thread-panel').hidden = false;
  if (matchMedia('(hover: hover)').matches) $('thread-input').focus();
}

/** Remember what a message says, so a thread can show what it hangs off. */
export function registerAnchor(chatId, uuid, text) {
  if (uuid && text) stateOf(chatId).anchors.set(uuid, text);
}

/** A message tagged with a thread: it belongs there, not in the feed. */
export function absorb(chatId, msg) {
  const state = stateOf(chatId);
  let thread = state.threads.get(msg.chatThread);
  if (!thread) {
    // the tag arrived before the thread list did — keep it, the list fills in later
    thread = { id: msg.chatThread, anchorUuid: null, msgs: [] };
    state.threads.set(msg.chatThread, thread);
  }
  // our own optimistic bubble is already there; the echo only confirms it
  if (msg.localId && thread.msgs.some((m) => m.localId === msg.localId)) return;
  if (msg.uuid && thread.msgs.some((m) => m.uuid === msg.uuid)) return;
  thread.msgs.push(msg);
  if (msg.type === 'result' && open?.threadId === thread.id) busy = false;
  refreshChips(chatId);
  if (open?.chatId === chatId && open.threadId === thread.id) renderPanel();
}

/** How many messages a thread holds, for the chip on its anchor. */
function threadSize(thread) {
  return thread.msgs.filter((m) => m.type === 'user' || (m.type === 'assistant' && textOf(m).trim())).length;
}

function textOf(msg) {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** The tag line is machine talk — it never belongs on screen. */
function stripMark(text) {
  return String(text ?? '').replace(/^\[remaude: thread [0-9a-f-]{8,}[^\]]*\]\n?/i, '');
}

// ---------- chips on the anchor messages ----------

export function refreshChips(chatId) {
  const state = stateOf(chatId);
  const byAnchor = new Map();
  for (const t of state.threads.values()) if (t.anchorUuid) byAnchor.set(t.anchorUuid, t);
  for (const node of document.querySelectorAll('.msg[data-uuid]')) {
    const thread = byAnchor.get(node.dataset.uuid);
    const chip = node.querySelector('.thread-chip');
    const size = thread ? threadSize(thread) : 0;
    if (!thread || !size) {
      chip?.remove();
      continue;
    }
    const label = `💬 ${size}`;
    if (chip) {
      chip.textContent = label;
      continue;
    }
    const fresh = el('button', 'thread-chip', label);
    fresh.title = 'open the thread';
    fresh.onclick = (e) => {
      e.stopPropagation();
      openThread(chatId, node.dataset.uuid);
    };
    node.append(fresh);
  }
}

/** The ↩ button every answer carries, and the chip if a thread is already there. */
export function decorate(chatId, node, uuid) {
  node.dataset.uuid = uuid;
  const reply = el('button', 'reply-btn', '↩');
  reply.title = 'reply in a thread';
  reply.onclick = (e) => {
    e.stopPropagation();
    openThread(chatId, uuid);
  };
  node.append(reply);
  refreshChips(chatId);
}

function openThread(chatId, anchorUuid) {
  const existing = [...stateOf(chatId).threads.values()].find((t) => t.anchorUuid === anchorUuid);
  if (existing) {
    onOpened({ chatId, threadId: existing.id });
    return;
  }
  request({ type: 'create_thread', chatId, anchorUuid }, chatId); // the server answers with thread_opened
}

// ---------- the panel ----------

function renderPanel() {
  if (!open) return;
  const thread = threadOf(open.chatId, open.threadId);
  const state = stateOf(open.chatId);
  const anchorText = thread?.anchorUuid ? state.anchors.get(thread.anchorUuid) : null;

  const anchor = $('thread-anchor');
  anchor.innerHTML = '';
  if (anchorText) {
    const quote = anchorText.replace(/\s+/g, ' ').slice(0, 220);
    anchor.append(el('div', 'thread-anchor-text', quote + (anchorText.length > 220 ? '…' : '')));
  } else {
    anchor.append(el('div', 'thread-anchor-text', 'the message this thread hangs off is not on screen'));
  }

  const body = $('thread-body');
  body.innerHTML = '';
  for (const msg of thread?.msgs ?? []) {
    if (msg.type === 'user') {
      const text = stripMark(textOf(msg));
      if (!text.trim()) continue;
      const row = el('div', 'thread-msg thread-mine', '');
      if (msg.author) row.append(el('div', 'msg-author', msg.author));
      row.append(document.createTextNode(text));
      body.append(row);
    } else if (msg.type === 'assistant') {
      const text = textOf(msg).trim();
      if (text) {
        const row = el('div', 'thread-msg thread-theirs md-body', '');
        row.innerHTML = mdToHtml(text);
        body.append(row);
      }
      // tools are not hidden work — a dim line keeps the thread honest
      for (const block of msg.message?.content ?? [])
        if (block.type === 'tool_use') body.append(el('div', 'thread-tool', `🔧 ${block.name}`));
    }
  }
  if (busy) body.append(el('div', 'thread-tool', '…'));
  if (!body.childElementCount) body.append(el('div', 'thread-empty', 'no replies yet — write the first one'));
  body.scrollTop = body.scrollHeight;
}

function sendToThread() {
  const area = $('thread-input');
  const text = area.value.trim();
  if (!text || !open) return;
  const localId = crypto.randomUUID();
  absorb(open.chatId, {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
    timestamp: new Date().toISOString(),
    localId,
    chatThread: open.threadId,
  });
  request({ type: 'send', chatId: open.chatId, content: text, localId, threadId: open.threadId }, open.chatId);
  area.value = '';
  busy = true;
  renderPanel();
}

function buildUi() {
  const panel = el('div', '', '');
  panel.id = 'thread-panel';
  panel.hidden = true;
  panel.innerHTML = `<div id="thread-box">
      <div id="thread-head"><span id="thread-title">Thread</span><button id="thread-close">✕</button></div>
      <div id="thread-anchor"></div>
      <div id="thread-body"></div>
      <div id="thread-composer">
        <textarea id="thread-input" rows="2" placeholder="reply in this thread…"></textarea>
        <button id="thread-send">Send</button>
      </div>
    </div>`;
  document.body.append(panel);

  $('thread-close').onclick = () => {
    $('thread-panel').hidden = true;
    open = null;
  };
  $('thread-send').onclick = sendToThread;
  $('thread-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      sendToThread();
    }
  });
}

/** Switching chats takes the panel with it — a thread belongs to one chat. */
export function chatSwitched(chatId) {
  if (!open || open.chatId === chatId) return;
  $('thread-panel').hidden = true;
  open = null;
}
