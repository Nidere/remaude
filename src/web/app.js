// remaude web UI: a thin client on top of the host agent's WS protocol.
import { mdToHtml } from './md.js';

const $ = (id) => document.getElementById(id);
const feedHost = $('feed');

// A pointer that can hover means a real keyboard: Enter sends and opening a chat
// may focus the composer. On touch devices Enter inserts a newline instead (the
// on-screen return key is the only way to break a line) and nothing is focused,
// so the keyboard stops covering the transcript.
const hasKeyboard = window.matchMedia('(hover: hover)').matches;

let ws;
let activeChatId = null;
const chats = new Map(); // chatId -> {hostId, projectPath, status, feedEl, streamEl, streamText, chips:Map, subagents:Map, historyRequested}
const attachments = []; // {mediaType, data(base64), url}

// Several hosts are served over one socket: own ones plus other people's hosts
// that shared chats with us. Everything from a host is tagged with its id, and
// commands carry it back so they reach the right machine. A relay that predates
// multiplexing sends no tag at all — then everything lives under LOCAL_HOST.
const LOCAL_HOST = 'local';
let knownHosts = []; // [{id, name, owner, own}] as reported by the relay
const hostStates = new Map(); // hostId -> {projects, guest}
let liveChats = new Set(); // chat ids the hosts actually report right now
const hostKey = (id) => id ?? LOCAL_HOST;

// Drafts survive the tab being evicted (iOS kills backgrounded PWAs at will),
// so they live in localStorage keyed by session id — chat ids change when the
// host restarts. Attachments stay in memory: base64 images would blow the quota.
const DRAFTS_KEY = 'drafts';
const loadDrafts = () => {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}');
  } catch {
    return {};
  }
};

function draftKey(chatId) {
  const chat = chats.get(chatId);
  return chat?.sessionId ?? chatId;
}

function saveDraft(chatId, text) {
  if (!chatId) return;
  const drafts = loadDrafts();
  if (text.trim()) drafts[draftKey(chatId)] = text;
  else delete drafts[draftKey(chatId)];
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota — the draft simply stays in memory */
  }
}

// The transcript of the chat you were last in is kept locally, so a relaunch
// after iOS evicted the app paints the conversation instantly instead of an
// empty feed; the live history from the host replaces it a moment later.
const TRANSCRIPT_KEEP = 120; // messages — most of them are tool calls, few are text
const TRANSCRIPT_BUDGET = 300_000; // characters — well under the storage quota

/** Strip what must never reach storage: base64 images and huge tool payloads. */
function slimMessage(msg) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return msg;
  return {
    ...msg,
    message: {
      ...msg.message,
      content: content.map((b) => {
        if (b.type === 'image') return { type: 'text', text: '🖼' };
        if (b.type === 'tool_result' && typeof b.content === 'string')
          return { ...b, content: b.content.slice(0, 500) };
        if (b.type === 'tool_result' && Array.isArray(b.content))
          return {
            ...b,
            content: b.content.map((c) =>
              c.type === 'image' ? { type: 'text', text: '🖼' } : { ...c, text: c.text?.slice(0, 500) }
            ),
          };
        return b;
      }),
    },
  };
}

function cacheTranscript(chatId) {
  const chat = chats.get(chatId);
  if (!chat?.msgs?.length) return;
  let slim = chat.msgs.slice(-TRANSCRIPT_KEEP).map(slimMessage);
  let payload = JSON.stringify(slim);
  while (payload.length > TRANSCRIPT_BUDGET && slim.length > 1) {
    slim = slim.slice(Math.ceil(slim.length / 2)); // drop the oldest half and retry
    payload = JSON.stringify(slim);
  }
  try {
    localStorage.setItem('transcript', JSON.stringify({ key: draftKey(chatId), msgs: slim }));
  } catch {
    /* quota — the cache is a nicety, not a requirement */
  }
}

/**
 * Paint the cached transcript before the socket says anything — after an
 * eviction the connection may take seconds, or never come back if we are
 * offline, and an empty feed is the whole problem we are solving.
 */
function bootFromCache() {
  const chatId = localStorage.getItem('lastChat');
  const key = localStorage.getItem('lastSession') ?? chatId;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('transcript') ?? 'null');
  } catch {
    return;
  }
  if (!chatId || !saved || saved.key !== key || !saved.msgs?.length) return;
  const chat = getChat(chatId);
  chat.sessionId = localStorage.getItem('lastSession') ?? undefined;
  chat.fromCache = true;
  activeChatId = chatId; // keeps the composer usable; the state handler retargets it
  feedHost.innerHTML = '';
  feedHost.append(chat.feedEl);
  for (const m of saved.msgs) renderSdkMessage(chatId, m, true);
  scrollToBottomSettled();
}

function cachedTranscript(chatId) {
  try {
    const saved = JSON.parse(localStorage.getItem('transcript') ?? 'null');
    return saved?.key === draftKey(chatId) ? saved.msgs : null;
  } catch {
    return null;
  }
}

/** Send a command to the host that owns this chat. */
function sendTo(hostId, obj) {
  send(hostId && hostId !== LOCAL_HOST ? { ...obj, _host: hostId } : obj);
}

function chatHostId(chatId) {
  return chats.get(chatId)?.hostId ?? LOCAL_HOST;
}

/** The first host we own — that's where "add project" and settings apply. */
function ownHostId() {
  for (const [hostId, st] of hostStates) if (!st.guest) return hostId;
  return LOCAL_HOST;
}

/** Is the active chat on someone else's host? Then the UI stays read-and-write only. */
function activeIsGuest() {
  const hostId = chatHostId(activeChatId);
  return Boolean(hostStates.get(hostId)?.guest);
}

// ---------- WS ----------

const outbox = []; // messages sent before the WS opened

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('conn-dot').classList.add('on');
    while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
    // history may have drifted after a reconnect — re-request it for the active chat
    for (const chat of chats.values()) chat.historyRequested = false;
    if (activeChatId) requestHistory(activeChatId);
  };
  ws.onclose = () => {
    $('conn-dot').classList.remove('on');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handlers[msg.type]?.(msg);
  };
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else outbox.push(obj);
}

// ---------- incoming ----------

const handlers = {
  hosts({ hosts }) {
    knownHosts = hosts;
    // hosts that went away take their chats with them
    const alive = new Set(hosts.map((h) => h.id));
    for (const id of [...hostStates.keys()]) if (!alive.has(id)) hostStates.delete(id);
    renderSidebar();
  },

  state({ projects, guest, _host }) {
    hostStates.set(hostKey(_host), { projects, guest: Boolean(guest) });
    // A snapshot is only true at the moment it arrives; live status then comes
    // from chat_status. Store it here so a later repaint (an agent update, say)
    // does not resurrect a stale "idle" from this frozen snapshot.
    for (const p of projects) for (const c of p.chats) getChat(c.id, p.path).status = c.status;
    // guest mode is per host now: the UI is restricted only while the active
    // chat belongs to someone else's host
    renderSidebar();
    // Only chats the host actually reports are real. The cache restore creates a
    // placeholder entry for the id we saw last time, and after a host restart
    // that id is dead: selecting it would leave the UI stuck on a chat nobody
    // updates — green status, messages going nowhere.
    const live = new Set();
    for (const st of hostStates.values()) for (const p of st.projects) for (const c of p.chats) live.add(c.id);
    liveChats = live;

    if (!activeChatId || !live.has(activeChatId)) {
      const last = localStorage.getItem('lastChat');
      const lastSession = localStorage.getItem('lastSession');
      let target = last && live.has(last) ? last : null;
      if (!target && lastSession) {
        for (const id of live) {
          if (chats.get(id)?.sessionId === lastSession) {
            target = id;
            break;
          }
        }
      }
      if (target) selectChat(target);
    }
  },

  chat_created({ chatId }) {
    selectChat(chatId);
  },

  chat_message({ chatId, msg }) {
    renderSdkMessage(chatId, msg);
    // unread: meaningful events in inactive chats
    if (chatId !== activeChatId && (msg.type === 'assistant' || msg.type === 'result')) {
      const chat = getChat(chatId);
      chat.unread = (chat.unread ?? 0) + (msg.type === 'result' ? 1 : 0);
      updateChatItem(chatId);
      updateTabState();
    }
  },

  chat_status({ chatId, status }) {
    const chat = chats.get(chatId);
    if (chat) {
      chat.status = status;
      if (status !== 'thinking' && status !== 'waiting_permission') chat.activity = null;
      if (chatId === activeChatId) renderActivity(chat);
    }
    updateStatusDot(chatId, status);
    if (chatId === activeChatId) updateComposerButtons(status);
    updateTabState();
  },

  chat_error({ chatId, error }) {
    appendTo(chatId, el('div', 'error-banner', `error: ${error}`));
  },

  permission_request({ requestId, chatId, toolName, input }) {
    const box = el('div', 'permission');
    box.dataset.requestId = requestId;
    box.append(
      el('div', 'perm-tool', `Allow ${toolName}?`),
      el('pre', '', JSON.stringify(input, null, 2).slice(0, 2000))
    );
    const buttons = el('div', 'perm-buttons');
    const allow = el('button', 'perm-allow', 'Allow');
    const deny = el('button', 'perm-deny', 'Deny');
    allow.onclick = () =>
      sendTo(chatHostId(chatId), { type: 'permission_response', requestId, result: { behavior: 'allow', updatedInput: input } });
    deny.onclick = () =>
      sendTo(chatHostId(chatId), { type: 'permission_response', requestId, result: { behavior: 'deny', message: 'Denied by the user' } });
    buttons.append(allow, deny);
    box.append(buttons);
    appendTo(chatId, box);
  },

  permission_closed({ requestId }) {
    document.querySelectorAll(`[data-request-id="${requestId}"]`).forEach((b) => b.classList.add('closed'));
  },

  permission_mode({ chatId, mode }) {
    const chat = getChat(chatId);
    chat.mode = mode;
    if (chatId === activeChatId) setModeSelect(mode);
  },

  chat_meta({ chatId, model, permissionMode, effort, context }) {
    const chat = getChat(chatId);
    chat.model = model;
    chat.mode = permissionMode;
    chat.effort = effort;
    chat.context = context;
    if (chatId === activeChatId) {
      renderMeta(chat);
      syncHeaderSelects(chat);
    }
  },

  limits({ limits }) {
    renderLimits(limits);
  },

  history({ chatId, messages }) {
    const chat = getChat(chatId);
    chat.feedEl.innerHTML = '';
    chat.chips.clear();
    chat.subagents.clear();
    chat.msgs = [];
    chat.fromCache = false;
    for (const m of messages) renderSdkMessage(chatId, m);
    if (chatId === activeChatId) {
      scrollToBottomSettled();
      cacheTranscript(chatId);
    }
  },

  search_results({ query, results, hasMore, scanned, total, _host }) {
    if (query !== $('search').value.trim()) return; // a stale page for an older query
    renderSearchResults(results, { hasMore, scanned, total, hostId: hostKey(_host), append: searchAppending });
    searchAppending = false;
  },

  attachments({ chatId, images, imagesTotal, docs, offset }) {
    if (chatId !== activeChatId) return;
    attState.images = offset ? [...attState.images, ...images] : images;
    if (!offset) attState.docs = docs ?? [];
    attState.total = imagesTotal;
    renderAttachments2();
  },

  artifact({ path, name, text, base64 }) {
    if (text != null) {
      $('doc-title').textContent = name;
      $('doc-body').innerHTML = mdToHtml(text);
      $('doc-viewer').hidden = false;
      return;
    }
    // not markdown: hand it to the browser as a download
    const a = document.createElement('a');
    a.href = `data:application/octet-stream;base64,${base64}`;
    a.download = name;
    a.click();
  },

  artifact_added({ artifact }) {
    if (!$('attachments-panel').hidden) requestAttachments(0);
  },

  agents({ chatId, agents }) {
    getChat(chatId).agents = agents;
    renderSidebar();
  },

  root_listing({ root, dirs, added, error, _host }) {
    const addedSet = new Set(added.map((p) => p.toLowerCase()));
    const sep = root.includes('\\') ? '\\' : '/';
    openModal(
      `Folders in ${root}`,
      error
        ? [{ label: `error: ${error}`, muted: true }]
        : dirs.map((name) => {
            const isAdded = addedSet.has(`${root}${sep}${name}`.toLowerCase());
            return {
              label: name,
              muted: isAdded,
              check: isAdded,
              onclick: isAdded ? null : () => sendTo(hostKey(_host), { type: 'add_from_root', name }),
            };
          }),
      // a folder outside the projects root is still reachable — by full path
      { placeholder: '…or type a full path', onSubmit: (path) => sendTo(hostKey(_host), { type: 'add_project', path }) }
    );
  },

  sessions({ projectPath, sessions, live, _host }) {
    openModal(
      `Past chats · ${shortPath(projectPath)}`,
      sessions.length
        ? sessions.map((s) => ({
            label: s.title ?? s.preview ?? s.id.slice(0, 8),
            sub: `${new Date(s.mtime).toLocaleString()}${live[s.id] ? ' · already open' : ''}`,
            check: Boolean(live[s.id]),
            onclick: live[s.id]
              ? () => selectChat(live[s.id])
              : () =>
                  sendTo(hostKey(_host), {
                    type: 'open_session',
                    projectPath,
                    sessionId: s.id,
                    permissionMode: $('permission-mode').value,
                  }),
          }))
        : [{ label: 'no saved sessions', muted: true }]
    );
  },

  share_result({ emails }) {
    if (!$('share-panel').hidden) renderShares(emails);
  },

  server_restarting() {
    $('conn-dot').classList.remove('on');
  },

  settings({ userName, projectsRoot, relay, claudeAuth }) {
    $('set-username').value = userName ?? '';
    $('set-root').value = projectsRoot ?? '';
    renderRelayStatus(relay);
    renderClaudeAuth(claudeAuth);
    $('settings').hidden = false;
  },

  claude_login_url({ url }) {
    const link = $('claude-login-link');
    link.href = url;
    $('claude-login-flow').hidden = false;
    $('claude-login-btn').textContent = 'Start over';
  },

  claude_auth({ status }) {
    renderClaudeAuth(status);
    $('claude-login-flow').hidden = true;
    $('claude-login-btn').textContent = 'Sign in to Claude';
    $('claude-login-code').value = '';
  },

  relay_status(relay) {
    renderRelayStatus(relay);
  },

  device_approved() {
    const node = $('relay-status');
    if (node) node.textContent = 'device approved ✓ — reload the page on it';
  },

  error({ message }) {
    if (activeChatId) appendTo(activeChatId, el('div', 'error-banner', `error: ${message}`));
    else alert(message);
  },
};

// ---------- chat model ----------

function getChat(chatId, projectPath) {
  if (!chats.has(chatId)) {
    const feedEl = document.createElement('div');
    feedEl.style.display = 'contents';
    chats.set(chatId, {
      projectPath: projectPath ?? '',
      title: null,
      status: 'idle',
      feedEl,
      streamEl: null,
      streamText: '',
      chips: new Map(),
      subagents: new Map(),
      historyRequested: false,
    });
  }
  const chat = chats.get(chatId);
  if (projectPath) chat.projectPath = projectPath;
  return chat;
}

function requestHistory(chatId) {
  const chat = getChat(chatId);
  if (chat.historyRequested) return;
  chat.historyRequested = true;
  // paint the cached transcript while the real one travels from the host
  if (!chat.feedEl.childElementCount && !chat.fromCache) {
    const cached = cachedTranscript(chatId);
    if (cached) {
      chat.fromCache = true;
      for (const m of cached) renderSdkMessage(chatId, m, true);
      if (chatId === activeChatId) scrollToBottomSettled();
    }
  }
  sendTo(chatHostId(chatId), { type: 'history', chatId });
}

function selectChat(chatId) {
  // the draft belongs to the chat: save the current one, restore the new one
  if (activeChatId && chats.has(activeChatId)) {
    const prev = chats.get(activeChatId);
    prev.draftText = $('input').value;
    prev.draftAtt = attachments.slice();
  }
  activeChatId = chatId;
  localStorage.setItem('lastChat', chatId);
  const chat = getChat(chatId);
  if (chat.sessionId) localStorage.setItem('lastSession', chat.sessionId);
  $('input').value = chat.draftText ?? loadDrafts()[draftKey(chatId)] ?? '';
  $('input').dispatchEvent(new Event('input')); // recompute the height
  attachments.length = 0;
  attachments.push(...(chat.draftAtt ?? []));
  renderAttachments();
  feedHost.innerHTML = '';
  feedHost.append(chat.feedEl);
  requestHistory(chatId);
  $('chat-title').textContent = `${shortPath(chat.projectPath)} · ${chat.title ?? chatId.slice(0, 8)}`;
  if (chat.mode) setModeSelect(chat.mode);
  renderMeta(chat);
  updateComposerButtons(chat.status);
  document.querySelectorAll('.chat-item').forEach((n) => n.classList.toggle('active', n.dataset.chatId === chatId));
  const cur = chats.get(chatId);
  // host controls stay hidden while we are looking at someone else's chat
  document.body.classList.toggle('guest', activeIsGuest());
  reportFocus();
  cur.unread = 0;
  updateChatItem(chatId);
  updateTabState();
  syncHeaderSelects(cur);
  closeSidebar();
  if (hasKeyboard) $('input').focus();
  scrollToBottomSettled();
}

function syncHeaderSelects(chat) {
  const shortModel = (chat.model ?? '').replace(/^claude-/, '').replace(/-[\d.]+.*$/, '');
  $('model-select').value = ['fable', 'opus', 'sonnet', 'haiku'].includes(shortModel) ? shortModel : '';
  // the effective effort comes from the server in chat_meta (override or host default)
  $('effort-select').value = ['low', 'medium', 'high', 'xhigh', 'max'].includes(chat.effort) ? chat.effort : '';
}

// ---------- rendering SDK messages ----------

function renderSdkMessage(chatId, msg, fromCache = false) {
  const chat = getChat(chatId);
  if (!fromCache && msg.type !== 'stream_event') {
    (chat.msgs ??= []).push(msg);
    if (chat.msgs.length > TRANSCRIPT_KEEP * 2) chat.msgs.splice(0, chat.msgs.length - TRANSCRIPT_KEEP);
    if (msg.type === 'result' && chatId === activeChatId) cacheTranscript(chatId);
  }

  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (msg.parent_tool_use_id !== null || ev.type !== 'content_block_delta') return;
    const kind = ev.delta?.type === 'text_delta' ? 'text' : ev.delta?.type === 'thinking_delta' ? 'think' : null;
    if (!kind) return;
    if (!chat.streamEl || chat.streamKind !== kind) {
      // thinking → text transition (or the other way round): a new bubble
      if (chat.streamEl && chat.streamKind === 'think') chat.streamEl.remove();
      chat.streamEl = el('div', `msg msg-assistant streaming${kind === 'think' ? ' thinking' : ''}`, '');
      chat.streamText = '';
      chat.streamKind = kind;
      chat.feedEl.append(chat.streamEl);
    }
    chat.streamText += kind === 'text' ? ev.delta.text : ev.delta.thinking;
    chat.streamEl.textContent = chat.streamText;
    scrollToBottom();
    return;
  }

  const isSub = msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined;

  if (msg.type === 'assistant') {
    if (isSub) return renderSubagent(chat, msg);
    dropStream(chat);
    if (msg.error === 'authentication_failed') {
      chat.feedEl.append(
        el('div', 'error-banner', 'The host is signed out of Claude. Sign in again: ⚙ settings → “Sign in to Claude”.')
      );
    }
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim()) {
        const node = el('div', 'msg msg-assistant md-body', '');
        node.innerHTML = mdToHtml(block.text);
        node.title = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : new Date().toLocaleString();
        node.append(el('span', 'msg-time', fmtTime(msg.timestamp)));
        const copyBtn = el('button', 'copy-btn', '⧉');
        copyBtn.title = 'copy as markdown';
        const source = block.text;
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(source);
          copyBtn.textContent = '✓';
          setTimeout(() => (copyBtn.textContent = '⧉'), 1200);
        };
        node.append(copyBtn);
        chat.feedEl.append(node);
      } else if (block.type === 'tool_use') {
        // even with tools hidden, something has to say the work is moving
        chat.activity = toolSummary(block);
        if (chatId === activeChatId) renderActivity(chat);
        const chip = makeChip(`${block.name}`, JSON.stringify(block.input, null, 2).slice(0, 4000));
        chat.chips.set(block.id, chip);
        chat.feedEl.append(chip);
      }
    }
    scrollToBottom();
    return;
  }

  if (msg.type === 'user') {
    if (isSub) return renderSubagent(chat, msg);
    const content = msg.message?.content;
    if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
      for (const block of content) if (block.type === 'tool_result') attachToolResult(chat, block);
      return;
    }
    // an ordinary user message; already on screen if we drew it optimistically
    if (msg.localId && chat.feedEl.querySelector(`[data-local-id="${msg.localId}"]`)) return;
    // belt and braces: the same text may come back without our localId (host
    // restart, transcript tail, a second delivery path). Adopt the optimistic
    // bubble instead of stacking a copy under it.
    const plainText =
      typeof content === 'string'
        ? content
        : (content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
    if (plainText) {
      for (const prev of chat.feedEl.querySelectorAll('.msg-user[data-pending-text]')) {
        if (prev.dataset.pendingText !== plainText) continue;
        delete prev.dataset.pendingText;
        if (msg.author && !prev.querySelector('.msg-author'))
          prev.prepend(el('div', 'msg-author', msg.author)); // the echo knows who sent it
        return;
      }
    }
    const bubble = el('div', 'msg msg-user', '');
    if (msg.localId) bubble.dataset.localId = msg.localId;
    // ours until the echo confirms it; the echo then matches by this text
    if (msg.localId && !msg.author && plainText) bubble.dataset.pendingText = plainText;
    if (msg.author) bubble.append(el('div', 'msg-author', msg.author));
    if (typeof content === 'string') bubble.append(document.createTextNode(content));
    else
      for (const block of content ?? []) {
        if (block.type === 'text') bubble.append(document.createTextNode(block.text));
        if (block.type === 'image' && block.source?.type === 'base64') {
          const img = document.createElement('img');
          img.src = `data:${block.source.media_type};base64,${block.source.data}`;
          bubble.append(img);
        }
      }
    bubble.append(el('span', 'msg-time', fmtTime(msg.timestamp)));
    chat.feedEl.append(bubble);
    scrollToBottom();
    return;
  }

  if (msg.type === 'result') {
    dropStream(chat);
    const meta = el('div', 'msg-meta', `${(msg.duration_ms / 1000).toFixed(1)}s`);
    if (msg.total_cost_usd != null)
      meta.title = `estimated API equivalent: $${msg.total_cost_usd.toFixed(2)} — not charged on a subscription; real usage is in the limits widget`;
    chat.feedEl.append(meta);
    scrollToBottom();
  }
}

/** A short "what is happening right now" line for the activity strip. */
function toolSummary(block) {
  const i = block.input ?? {};
  const file = (p) => String(p).split(/[\\/]/).pop();
  switch (block.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${block.name} · ${file(i.file_path ?? '')}`;
    case 'Bash':
    case 'PowerShell':
      return `${block.name} · ${String(i.description ?? i.command ?? '').slice(0, 60)}`;
    case 'Grep':
    case 'Glob':
      return `${block.name} · ${String(i.pattern ?? '').slice(0, 40)}`;
    case 'Agent':
      return `Agent · ${String(i.description ?? '').slice(0, 50)}`;
    case 'WebFetch':
    case 'WebSearch':
      return `${block.name} · ${String(i.url ?? i.query ?? '').slice(0, 50)}`;
    default:
      return block.name;
  }
}

function renderActivity(chat) {
  const busy = chat?.status === 'thinking' || chat?.status === 'waiting_permission';
  const strip = $('activity');
  strip.hidden = !busy;
  if (!busy) return;
  $('activity-text').textContent =
    chat.status === 'waiting_permission' ? 'waiting for your permission' : (chat.activity ?? 'thinking…');
}

function dropStream(chat) {
  chat.streamEl?.remove();
  chat.streamEl = null;
  chat.streamText = '';
  chat.streamKind = null;
}

function makeChip(title, body) {
  const chip = document.createElement('details');
  chip.className = 'chip';
  const summary = el('summary', '', title);
  chip.append(summary);
  if (body) chip.append(el('pre', '', body));
  return chip;
}

function attachToolResult(chat, block) {
  const chip = chat.chips.get(block.tool_use_id);
  const target = chip ?? chat.feedEl.appendChild(makeChip('result', ''));
  const wrap = el('div', 'result-block', '');
  const content = block.content;
  if (typeof content === 'string') wrap.append(el('pre', '', content.slice(0, 4000)));
  else
    for (const b of content ?? []) {
      if (b.type === 'text') wrap.append(el('pre', '', b.text.slice(0, 4000)));
      if (b.type === 'image' && b.source?.type === 'base64') {
        const img = document.createElement('img');
        img.src = `data:${b.source.media_type};base64,${b.source.data}`;
        wrap.append(img);
      }
    }
  target.append(wrap);
}

function renderSubagent(chat, msg) {
  const pid = msg.parent_tool_use_id;
  if (!chat.subagents.has(pid)) {
    const group = makeChip(`subagent ${pid.slice(-6)}`, '');
    chat.subagents.set(pid, group);
    // if there is an Agent-tool chip, put it next to that one, otherwise at the end
    chat.feedEl.append(group);
  }
  const group = chat.subagents.get(pid);
  const text = (msg.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text.trim()) group.append(el('pre', '', `[${msg.type}] ${text.slice(0, 2000)}`));
}

// ---------- list modal ----------

/** @param input optional {placeholder, onSubmit} row under the list (e.g. a manual path) */
function openModal(title, items, input = null) {
  $('picker-title').textContent = title;
  const form = $('picker-form');
  form.hidden = !input;
  if (input) {
    $('picker-input').placeholder = input.placeholder ?? '';
    $('picker-input').value = '';
    form.onsubmit = (e) => {
      e.preventDefault();
      const value = $('picker-input').value.trim();
      if (!value) return;
      $('picker').hidden = true;
      input.onSubmit(value);
    };
  }
  const list = $('picker-list');
  list.innerHTML = '';
  for (const it of items) {
    const item = el('div', `picker-item${it.muted ? ' added' : ''}${it.check ? ' added' : ''}`, '');
    item.append(el('div', '', it.label));
    if (it.sub) item.append(el('div', 'picker-sub', it.sub));
    if (it.onclick)
      item.onclick = () => {
        $('picker').hidden = true;
        it.onclick();
      };
    list.append(item);
  }
  $('picker').hidden = false;
}

// ---------- sidebar ----------

function renderSidebar() {
  const root = $('projects');
  root.innerHTML = '';
  // own hosts first, then other people's, each as its own section
  const sections = [...hostStates.entries()].sort(
    (a, b) => Number(a[1].guest) - Number(b[1].guest) || a[0].localeCompare(b[0])
  );
  for (const [hostId, hostState] of sections) {
    const meta = knownHosts.find((h) => h.id === hostId);
    // shared hosts are labelled by their owner's email, own ones by machine name
    const label = hostState.guest ? (meta?.owner ?? 'shared') : (meta?.name ?? 'this computer');
    const head = el('div', `host-head${hostState.guest ? ' guest' : ''}`, '');
    head.append(el('span', 'host-name', label));
    if (!editMode && !hostState.guest) {
      // same shape as "+ new chat" inside a project, one level up
      const actions = el('span', 'host-actions', '');
      const btnAdd = el('button', '', '+');
      btnAdd.title = 'add project';
      btnAdd.onclick = (e) => {
        e.stopPropagation();
        sendTo(hostId, { type: 'list_root' });
      };
      const btnShare = el('button', '', '🔗');
      btnShare.title = 'share this whole computer';
      btnShare.onclick = (e) => {
        e.stopPropagation();
        openShare(
          { host: true, hostId },
          'Host access',
          'A guest can write into every chat on this machine, and chats run in bypass — that is command execution on your computer under your account. Share a host only with someone you trust that far.'
        );
      };
      actions.append(btnAdd, btnShare);
      head.append(actions);
    }
    if (editMode && !hostState.guest && meta) {
      head.dataset.sortId = hostId;
      makeDraggable(head, 'host', (ids) => hostApi('order', { ids }).catch((e) => alert(e.message)));
      head.append(
        editActions({
          onRename: async () => {
            const name = prompt('Host name:', meta.name ?? '');
            if (name?.trim()) await hostApi('rename', { hostId, name: name.trim() }).catch((e) => alert(e.message));
          },
          onDelete: async () => {
            if (!confirm(`Unpair “${meta.name ?? hostId}”? That machine will need a new invite link.`)) return;
            await hostApi('delete', { hostId }).catch((e) => alert(e.message));
          },
          deleteTitle: 'unpair this computer',
        })
      );
    }
    root.append(head);
    renderHostProjects(root, hostId, hostState);
  }
  renderAddHost($('sidebar-footer'));
}

function renderHostProjects(root, hostId, hostState) {
  for (const p of hostState.projects) {
    const proj = el('div', 'project', '');

    const head = el('div', 'project-head', '');
    const name = el('span', 'project-name', p.name ?? p.path.split(/[\\/]/).filter(Boolean).pop());
    name.title = p.path;
    proj.append(head);
    if (editMode && !hostState.guest) {
      proj.dataset.sortId = p.path;
      makeDraggable(proj, `projects-${hostId}`, (paths) => sendTo(hostId, { type: 'reorder_projects', paths }));
      head.append(
        name,
        editActions({
          onRename: () => {
            const label = prompt('Project name (display only):', p.name ?? '');
            if (label !== null) sendTo(hostId, { type: 'rename_project', path: p.path, name: label });
          },
          onDelete: () => {
            if (confirm(`Remove “${shortPath(p.path)}” from the sidebar? Nothing is deleted on disk.`))
              sendTo(hostId, { type: 'close_project', path: p.path });
          },
          deleteTitle: 'remove project from the sidebar',
        })
      );
    } else if (!hostState.guest) {
      const actions = el('span', 'project-actions', '');
      const btnNew = el('button', '', '+');
      btnNew.title = 'new chat';
      btnNew.onclick = () =>
        sendTo(hostId, { type: 'create_chat', projectPath: p.path, permissionMode: $('permission-mode').value });
      const btnOld = el('button', '', '⏳');
      btnOld.title = 'past chats';
      btnOld.onclick = () => sendTo(hostId, { type: 'list_sessions', projectPath: p.path });
      const btnShare = el('button', '', '🔗');
      btnShare.title = 'share the whole project';
      btnShare.onclick = (e) => {
        e.stopPropagation();
        openShare(
          { projectPath: p.path, hostId },
          `Project access · ${shortPath(p.path)}`,
          'Guests see every chat in this project, including ones created later, and may start new chats here.'
        );
      };
      // no delete outside edit mode: removing things is what edit mode is for
      actions.append(btnNew, btnOld, btnShare);
      head.append(name, actions);
    } else {
      head.append(name);
    }

    const filter = $('search').value.trim().toLowerCase();
    let visibleChats = 0;
    for (const c of p.chats) {
      const chat = getChat(c.id, p.path);
      chat.hostId = hostId;
      chat.title = c.title;
      chat.sessionId = c.sessionId;
      if (c.model) chat.model = c.model;
      if (c.permissionMode) chat.mode = c.permissionMode;
      const labelText = c.title ?? (c.sessionId ? c.id.slice(0, 8) : 'new');
      if (filter && !labelText.toLowerCase().includes(filter) && !p.path.toLowerCase().includes(filter)) continue;
      visibleChats++;

      const item = el('div', 'chat-item', '');
      item.dataset.chatId = c.id;
      const dot = el('span', `status-dot ${chat.status ?? c.status}`, ''); // live status wins over the snapshot
      const label = el('span', 'chat-label', labelText);
      item.append(dot, label);

      if (chat.unread) {
        item.classList.add('unread');
        item.append(el('span', 'unread-badge', String(chat.unread)));
      }

      if (editMode && !hostState.guest) {
        item.dataset.sortId = c.id;
        makeDraggable(item, `chats-${p.path}`, (chatIds) =>
          sendTo(hostId, { type: 'reorder_chats', projectPath: p.path, chatIds })
        );
        item.append(
          editActions({
            onRename: () => {
              const name = prompt('Chat name:', c.title ?? '');
              if (name?.trim()) sendTo(hostId, { type: 'rename_chat', chatId: c.id, title: name.trim() });
            },
            onDelete: () => {
              if (confirm('Close this chat? The session stays — reopen it via “past chats”.'))
                sendTo(hostId, { type: 'hide_chat', chatId: c.id });
            },
            deleteTitle: 'close chat (the session stays on disk)',
          })
        );
      }

      if (c.id === activeChatId) item.classList.add('active');
      // in edit mode a tap must not navigate — that is the whole point of it
      item.onclick = () => {
        if (!editMode) selectChat(c.id);
      };
      proj.append(item);

      // running subagents, one line each, purely informational
      for (const a of chat.agents ?? []) {
        const row = el('div', 'agent-item', '');
        row.dataset.agentId = a.id;
        row.append(el('span', `status-dot agent-${a.status}`, ''));
        row.append(el('span', 'agent-label', a.label ?? a.type ?? 'agent'));
        const time = el('span', 'agent-time', agentElapsed(a));
        time.dataset.startedAt = a.startedAt;
        time.dataset.status = a.status;
        row.append(time);
        row.title = [a.type, a.status].filter(Boolean).join(' · ');
        proj.append(row);
      }
    }
    if (filter && !visibleChats && !p.path.toLowerCase().includes(filter)) continue;
    root.append(proj);
  }
}

// ---------- attachments: gallery and document inbox ----------

let attState = { tab: 'images', images: [], docs: [], total: 0, offset: 0 };

/** Segmented toggle: reads the active button, or flips to a new value. */
function seg(id, value) {
  const box = $(id);
  if (value === undefined) return box.querySelector('.active')?.dataset.value;
  for (const b of box.children) b.classList.toggle('active', b.dataset.value === value);
  return value;
}

function bindSeg(id, onChange) {
  for (const button of $(id).children)
    button.onclick = () => {
      if (button.classList.contains('active')) return;
      seg(id, button.dataset.value);
      onChange(button.dataset.value);
    };
}

function openAttachments() {
  if (!activeChatId) return;
  attState = { ...attState, images: [], docs: [], total: 0, offset: 0 };
  $('attachments-panel').hidden = false;
  $('att-body').innerHTML = '<div class="att-empty">loading…</div>';
  requestAttachments(0);
}

function requestAttachments(offset) {
  sendTo(chatHostId(activeChatId), {
    type: 'attachments',
    chatId: activeChatId,
    scope: seg('att-scope'),
    offset,
  });
}

function renderAttachments2() {
  const body = $('att-body');
  body.innerHTML = '';
  $('att-filter').hidden = attState.tab !== 'images';

  if (attState.tab === 'images') {
    const mineOnly = seg('att-filter') === 'mine';
    const shown = attState.images.filter((i) => !mineOnly || i.mine);
    if (!shown.length) {
      body.append(el('div', 'att-empty', 'no images here yet'));
      return;
    }
    const grid = el('div', 'att-grid', '');
    for (const img of shown) {
      const cell = el('div', 'att-cell', '');
      const image = document.createElement('img');
      image.src = `data:${img.mediaType};base64,${img.data}`;
      image.loading = 'lazy';
      if (img.ts) cell.title = new Date(img.ts).toLocaleString();
      cell.append(image);
      cell.onclick = () => {
        $('lightbox').querySelector('img').src = image.src;
        $('lightbox').hidden = false;
      };
      grid.append(cell);
    }
    body.append(grid);
    if (attState.images.length < attState.total) {
      const more = el('button', 'att-more', `show more (${attState.images.length}/${attState.total})`);
      more.onclick = () => {
        more.textContent = 'loading…';
        requestAttachments(attState.images.length);
      };
      body.append(more);
    }
    return;
  }

  if (!attState.docs.length) {
    body.append(
      el('div', 'att-empty', 'no documents yet — they appear here when a written file is marked for you')
    );
    return;
  }
  for (const doc of attState.docs) {
    const ext = (doc.name.split('.').pop() ?? '').toLowerCase();
    const row = el('div', `att-doc${doc.missing ? ' missing' : ''}`, '');
    row.append(el('div', `att-ext ext-${ext}`, ext.slice(0, 4)));
    const info = el('div', 'att-doc-info', '');
    info.append(el('div', 'att-doc-name', doc.title ?? doc.name));
    const meta = [
      doc.name,
      doc.missing ? 'missing on disk' : formatSize(doc.size),
      new Date(doc.addedAt).toLocaleDateString(),
    ]
      .filter(Boolean)
      .join(' · ');
    info.append(el('div', 'att-doc-meta', meta));
    row.append(info);

    const drop = el('button', 'att-doc-drop', '✕');
    drop.title = 'remove from the inbox (the file stays on disk)';
    drop.onclick = (e) => {
      e.stopPropagation();
      sendTo(chatHostId(activeChatId), { type: 'remove_artifact', path: doc.path });
      attState.docs = attState.docs.filter((d) => d.path !== doc.path);
      renderAttachments2();
    };
    row.append(drop);

    if (!doc.missing)
      row.onclick = () =>
        sendTo(chatHostId(activeChatId), { type: 'read_artifact', path: doc.path, asText: ext === 'md' });
    body.append(row);
  }
}

function formatSize(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- search across saved transcripts ----------
// The sidebar filter alone only ever saw open chats. Real search asks the host
// to grep its saved sessions, page by page, so digging deeper stays possible.

let searchTimer = null;
let searchAppending = false;

function runSearch(more = false) {
  const query = $('search').value.trim();
  if (query.length < 2) {
    $('search-results').innerHTML = '';
    return;
  }
  searchAppending = more;
  if (!more) $('search-results').innerHTML = `<div class="search-head">searching…</div>`;
  sendTo(ownHostId(), { type: 'search', query, more });
}

function renderSearchResults(results, { hasMore, scanned, total, hostId, append }) {
  const root = $('search-results');
  if (!append) root.innerHTML = '';
  root.querySelector('.search-head')?.remove();
  root.querySelector('.search-more')?.remove();

  const count = root.querySelectorAll('.search-item').length + results.length;
  const head = el('div', 'search-head', count ? `found in past chats: ${count}` : 'nothing found in past chats');
  root.prepend(head);

  for (const r of results) {
    const item = el('div', 'search-item', '');
    item.append(el('div', 'search-title', r.title ?? r.sessionId.slice(0, 8)));
    if (r.snippet) item.append(el('div', 'search-snippet', r.snippet));
    const where = [r.projectPath ? shortPath(r.projectPath) : null, new Date(r.mtime).toLocaleDateString()]
      .filter(Boolean)
      .join(' · ');
    item.append(el('div', 'search-meta', `${where} · ${r.matches} match${r.matches > 1 ? 'es' : ''}`));
    if (r.projectPath)
      item.onclick = () =>
        sendTo(hostId, {
          type: 'open_session',
          projectPath: r.projectPath,
          sessionId: r.sessionId,
          permissionMode: $('permission-mode').value,
        });
    root.append(item);
  }

  if (hasMore) {
    const more = el('button', 'search-more', `show more (${scanned}/${total} scanned)`);
    more.onclick = () => {
      more.textContent = 'searching…';
      runSearch(true);
    };
    root.append(more);
  }
}

// ---------- sidebar edit mode ----------
// One switch turns the sidebar from navigation into editing: rows become
// draggable (pointer events, so a finger works like a mouse), rename/remove
// appear, and plain clicks stop navigating so nothing happens by accident.

let editMode = false;

function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle('editing', on);
  $('edit-btn').classList.toggle('active', on);
  renderSidebar();
}

/**
 * Reorder rows by dragging. `group` marks which rows may swap with each other,
 * so chats stay inside their project and projects inside their host.
 * onDrop receives the new order of data-sort-id values within the group.
 */
function makeDraggable(row, group, onDrop) {
  row.dataset.sortGroup = group;
  row.addEventListener('pointerdown', (e) => {
    if (!editMode || e.button > 0 || e.target.closest('button')) return;
    e.preventDefault();
    const parent = row.parentElement;
    const siblings = () => [...parent.querySelectorAll(`[data-sort-group="${group}"]`)];
    row.classList.add('dragging');

    // Listeners live on the window, not on the row: moving a node in the DOM
    // drops its pointer capture, and the drag would freeze after the first swap.
    const onMove = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[data-sort-group="${group}"]`);
      if (!target || target === row || target.parentElement !== parent) return;
      const rect = target.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      parent.insertBefore(row, after ? target.nextSibling : target);
    };
    const onUp = () => {
      row.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      onDrop(siblings().map((n) => n.dataset.sortId));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

/** The rename/remove pair shown on a row in edit mode. */
function editActions({ onRename, onDelete, deleteTitle }) {
  const box = el('span', 'edit-actions', '');
  const rename = el('button', '', '✎');
  rename.title = 'rename';
  rename.onclick = (e) => {
    e.stopPropagation();
    onRename();
  };
  const remove = el('button', '', '✕');
  remove.title = deleteTitle ?? 'remove';
  remove.onclick = (e) => {
    e.stopPropagation();
    onDelete();
  };
  box.append(rename, remove);
  return box;
}

async function hostApi(path, body) {
  const res = await fetch(`/api/hosts/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('the relay declined the request (works through the relay, not on localhost)');
}

function agentElapsed(a) {
  if (a.status !== 'running') return a.status === 'done' ? '✓' : '✕';
  const sec = Math.max(0, Math.round((Date.now() - a.startedAt) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}`;
}

// tick the running agents' timers without redrawing the whole sidebar
setInterval(() => {
  for (const node of document.querySelectorAll('.agent-time')) {
    if (node.dataset.status !== 'running') continue;
    node.textContent = agentElapsed({ status: 'running', startedAt: Number(node.dataset.startedAt) });
  }
}, 1000);

/** "Add host": the relay mints a one-time invite link to open (or curl) on that machine. */
function renderAddHost(root) {
  root.innerHTML = '';
  const btn = el('button', 'add-host', '＋ add host');
  btn.title = 'connect another computer to this account';
  btn.onclick = async () => {
    try {
      const res = await fetch('/api/host-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error('the relay declined to issue an invite link');
      const { url, expiresInMinutes } = await res.json();
      showInvite(url, expiresInMinutes);
    } catch (e) {
      alert(`${e.message}. Adding hosts works through the relay, not on localhost.`);
    }
  };
  root.append(btn);
}

function showInvite(url, minutes) {
  $('picker-title').textContent = 'Connect a new host';
  $('picker-form').hidden = true; // the modal is shared: drop the previous screen's input row
  const list = $('picker-list');
  list.innerHTML = '';
  list.append(
    el(
      'div',
      'invite-hint',
      `On the computer you want to connect, open this link in a browser — or run it through curl in a terminal. It works once and expires in ${minutes} minutes.`
    )
  );
  const box = el('div', 'invite-url', url);
  list.append(box);
  const copy = el('button', 'invite-copy', 'Copy link');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = 'Copied ✓';
    } catch {
      // clipboard may be blocked — selecting the text is the fallback
      getSelection().selectAllChildren(box);
    }
  };
  list.append(copy);
  $('picker').hidden = false;
}

function updateChatItem(chatId) {
  const chat = chats.get(chatId);
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
  if (!item || !chat) return;
  item.classList.toggle('unread', Boolean(chat.unread));
  item.querySelector('.unread-badge')?.remove();
  if (chat.unread) item.insertBefore(el('span', 'unread-badge', String(chat.unread)), item.querySelector('.chat-actions'));
}

// ---------- tab: title + favicon ----------

const FAVICON_BASE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%92%AC%3C/text%3E%3C/svg%3E";
const FAVICON_ALERT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%92%AC%3C/text%3E%3Ccircle cx='12.5' cy='3.5' r='3.5' fill='%23f7768e'/%3E%3C/svg%3E";

function updateTabState() {
  let waiting = false;
  let unread = 0;
  for (const chat of chats.values()) {
    if (chat.status === 'waiting_permission') waiting = true;
    unread += chat.unread ?? 0;
  }
  document.title = waiting ? '● waiting for permission — remaude' : unread ? `(${unread}) remaude` : 'remaude';
  document.querySelector('link[rel="icon"]').href = waiting || unread ? FAVICON_ALERT : FAVICON_BASE;
}

function updateStatusDot(chatId, status) {
  document.querySelectorAll(`.chat-item[data-chat-id="${chatId}"] .status-dot`).forEach((d) => {
    d.className = `status-dot ${status}`;
  });
}

// ---------- chat meta in the header ----------

function renderMeta(chat) {
  const root = $('chat-meta');
  root.innerHTML = '';
  if (!chat) return;
  const pct = chat.context?.percentage;
  const cls = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '';
  const ctxSpan = el('span', cls, `ctx ${pct != null ? pct + '%' : '—'}`);
  if (chat.context) ctxSpan.title = `${chat.context.totalTokens.toLocaleString()} / ${chat.context.maxTokens.toLocaleString()} tokens`;
  root.append(ctxSpan);
}

// ---------- limits ----------

function renderLimits(limits) {
  const root = $('limits');
  root.innerHTML = '';
  if (!limits) return;
  const parts = [];
  if (limits.fiveHour) parts.push(['5h', limits.fiveHour]);
  if (limits.sevenDay) parts.push(['wk', limits.sevenDay]);
  for (const m of limits.modelScoped ?? []) parts.push([m.name, m]);
  root.append(
    ...parts.map(([label, w], i) => {
      const cls = w.utilization >= 90 ? 'crit' : w.utilization >= 70 ? 'warn' : '';
      const span = el('span', cls, `${i ? ' · ' : ''}${label} ${Math.round(w.utilization ?? 0)}%`);
      if (w.resetsAt) span.title = `resets: ${new Date(w.resetsAt).toLocaleString()}`;
      return span;
    })
  );
}

// ---------- composer ----------

function currentContent() {
  const text = $('input').value.trim();
  if (!attachments.length) return text || null;
  const blocks = attachments.map((a) => ({
    type: 'image',
    source: { type: 'base64', media_type: a.mediaType, data: a.data },
  }));
  if (text) blocks.unshift({ type: 'text', text });
  return blocks;
}

function sendMessage() {
  if (!activeChatId) return;
  const content = currentContent();
  if (!content) return;
  // Never swallow a message: if this chat is not one the host currently reports
  // (still connecting, or the id died with a host restart), say so and keep the
  // text in the composer instead of sending it into the void.
  if (!liveChats.has(activeChatId)) {
    appendTo(activeChatId, el('div', 'error-banner', 'not connected to this chat yet — the message was not sent'));
    return;
  }
  // draw the bubble at once instead of waiting for the echo to travel
  // browser → relay → host → back; the echo is then skipped by this id
  const localId = crypto.randomUUID();
  renderSdkMessage(activeChatId, {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
    timestamp: new Date().toISOString(),
    localId,
  });
  sendTo(chatHostId(activeChatId), { type: 'send', chatId: activeChatId, content, localId });
  $('input').value = '';
  autoGrowInput($('input'));
  attachments.length = 0;
  renderAttachments();
  const chat = chats.get(activeChatId);
  if (chat) {
    chat.draftText = '';
    chat.draftAtt = [];
    saveDraft(activeChatId, '');
  }
}

function updateComposerButtons(status) {
  $('stop-btn').hidden = status !== 'thinking' && status !== 'waiting_permission';
}

function renderAttachments() {
  const root = $('attachments');
  root.innerHTML = '';
  attachments.forEach((a, i) => {
    const wrap = el('div', 'att', '');
    const img = document.createElement('img');
    img.src = a.url;
    const del = el('button', '', '×');
    del.onclick = () => {
      attachments.splice(i, 1);
      renderAttachments();
    };
    wrap.append(img, del);
    root.append(wrap);
  });
}

// ---------- utilities and events ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function appendTo(chatId, node) {
  getChat(chatId).feedEl.append(node);
  scrollToBottom();
}

function shortPath(p) {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Pinning the feed to the bottom takes more than one attempt: right after a
 * re-render the layout is not final — web fonts land, code blocks and images
 * reflow — and a single scroll leaves you stranded mid-conversation.
 */
function scrollToBottomSettled() {
  scrollToBottom(true);
  requestAnimationFrame(() => scrollToBottom(true));
  document.fonts?.ready?.then(() => scrollToBottom(true));
  setTimeout(() => scrollToBottom(true), 250);
}

function scrollToBottom(force = false) {
  const nearBottom = feedHost.scrollHeight - feedHost.scrollTop - feedHost.clientHeight < 120;
  if (force || nearBottom) feedHost.scrollTop = feedHost.scrollHeight;
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  $('sidebar-overlay').hidden = true;
}

function setModeSelect(mode) {
  const sel = $('permission-mode');
  sel.value = mode;
  sel.classList.toggle('bypass', mode === 'bypassPermissions');
}

$('send-btn').onclick = sendMessage;
$('stop-btn').onclick = () => activeChatId && sendTo(chatHostId(activeChatId), { type: 'interrupt', chatId: activeChatId });

$('input').addEventListener('keydown', (e) => {
  if (hasKeyboard && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
function autoGrowInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
}
$('input').addEventListener('input', function () {
  autoGrowInput(this);
  saveDraft(activeChatId, this.value);
});

// Every pasted image is normalized to PNG (the Windows clipboard can hand over bmp
// and other things the API rejects) and oversized screenshots are scaled down.
async function addImageAttachment(file) {
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 1568; // the optimum per the vision docs
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    attachments.push({ mediaType: 'image/png', data: url.split(',')[1], url });
    renderAttachments();
  } catch {
    /* the clipboard holds something other than an image — ignore it */
  }
}

$('attach-btn').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', function () {
  for (const f of this.files) addImageAttachment(f);
  this.value = '';
});

$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file');
  if (!files.length) return;
  e.preventDefault();
  for (const item of files) {
    const file = item.getAsFile();
    if (file) addImageAttachment(file);
  }
});

$('picker-cancel').onclick = () => ($('picker').hidden = true);
$('picker').addEventListener('click', (e) => {
  if (e.target.id === 'picker') $('picker').hidden = true;
});

$('permission-mode').addEventListener('change', function () {
  setModeSelect(this.value);
  if (activeChatId) sendTo(chatHostId(activeChatId), { type: 'set_permission_mode', chatId: activeChatId, mode: this.value });
});

// lightbox: clicking any image in the feed opens a full-screen view
feedHost.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') {
    $('lightbox').querySelector('img').src = e.target.src;
    $('lightbox').hidden = false;
  }
});
$('lightbox').onclick = () => ($('lightbox').hidden = true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('lightbox').hidden = true;
});

// sharing the active chat
// ---------- sharing: one dialog for a chat, a project or a whole host ----------

let shareScope = null; // {chatId} | {projectPath} | {host:true}, plus hostId to route to

function openShare(scope, title, warning) {
  shareScope = scope;
  $('share-title').textContent = title;
  $('share-warning').textContent = warning ?? '';
  $('share-warning').hidden = !warning;
  $('share-list').innerHTML = '<div class="share-empty">loading…</div>';
  $('share-email').value = '';
  $('share-panel').hidden = false;
  sendTo(scope.hostId, { type: 'list_shares', ...scopeArgs(scope) });
}

function scopeArgs({ chatId, projectPath, host }) {
  return chatId ? { chatId } : projectPath ? { projectPath } : { host };
}

function renderShares(emails) {
  const list = $('share-list');
  list.innerHTML = '';
  if (!emails.length) {
    list.append(el('div', 'share-empty', 'not shared with anyone yet'));
    return;
  }
  for (const email of emails) {
    const row = el('div', 'share-row', '');
    row.append(el('span', 'share-avatar', email[0].toUpperCase()));
    row.append(el('span', 'share-email', email));
    const drop = el('button', 'share-drop', '✕');
    drop.title = 'revoke access';
    drop.onclick = () => sendTo(shareScope.hostId, { type: 'unshare_scope', ...scopeArgs(shareScope), email });
    row.append(drop);
    list.append(row);
  }
}

$('share-btn').onclick = () => {
  if (!activeChatId) return;
  openShare({ chatId: activeChatId, hostId: chatHostId(activeChatId) }, 'Chat access');
};
$('share-close').onclick = () => ($('share-panel').hidden = true);
$('share-panel').addEventListener('click', (e) => {
  if (e.target.id === 'share-panel') $('share-panel').hidden = true;
});
$('share-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('share-email').value.trim();
  if (!email || !shareScope) return;
  sendTo(shareScope.hostId, { type: 'share_scope', ...scopeArgs(shareScope), email });
  $('share-email').value = '';
});

// mobile menu
$('menu-btn').onclick = () => {
  document.getElementById('sidebar').classList.add('open');
  $('sidebar-overlay').hidden = false;
};
$('sidebar-overlay').onclick = closeSidebar;

// the “scroll down” button
feedHost.addEventListener('scroll', () => {
  const nearBottom = feedHost.scrollHeight - feedHost.scrollTop - feedHost.clientHeight < 200;
  $('scroll-down').hidden = nearBottom;
});
$('scroll-down').onclick = () => scrollToBottom(true);

// model and effort of the active chat
$('model-select').addEventListener('change', function () {
  if (activeChatId && this.value) sendTo(chatHostId(activeChatId), { type: 'set_model', chatId: activeChatId, model: this.value });
});
$('effort-select').addEventListener('change', function () {
  if (activeChatId && this.value) sendTo(chatHostId(activeChatId), { type: 'set_effort', chatId: activeChatId, effort: this.value });
});

// settings
function renderClaudeAuth(status) {
  const node = $('claude-auth-status');
  if (!status) {
    node.textContent = 'Claude account: status unknown';
    node.className = '';
  } else if (status.loggedIn) {
    node.textContent = `Claude account: ${status.email} · ${status.subscriptionType} ✓`;
    node.className = 'ok';
  } else {
    node.textContent = 'Claude account: signed out — sessions will not work!';
    node.className = 'bad';
  }
}

$('claude-login-btn').onclick = () => sendTo(ownHostId(), { type: 'claude_login_start' });
$('claude-login-send').onclick = () => {
  const code = $('claude-login-code').value.trim();
  if (code) sendTo(ownHostId(), { type: 'claude_login_code', code });
};

function renderRelayStatus(relay) {
  const node = $('relay-status');
  if (!node) return;
  if (!relay?.paired) node.textContent = 'relay: not paired — connect this host from the relay UI';
  else node.textContent = relay.connected ? 'relay: connected ✓' : 'relay: paired, no connection…';
  node.className = relay?.connected ? 'ok' : '';
}

$('pair-btn').onclick = () => {
  const code = $('set-pair-code').value.trim();
  if (!code) return;
  sendTo(ownHostId(), { type: 'pair_relay', code });
  $('set-pair-code').value = '';
};

$('att-btn').onclick = openAttachments;
$('att-close').onclick = () => ($('attachments-panel').hidden = true);
$('attachments-panel').addEventListener('click', (e) => {
  if (e.target.id === 'attachments-panel') $('attachments-panel').hidden = true;
});
for (const tab of document.querySelectorAll('.att-tab'))
  tab.onclick = () => {
    document.querySelectorAll('.att-tab').forEach((t) => t.classList.toggle('active', t === tab));
    attState.tab = tab.dataset.tab;
    renderAttachments2();
  };
bindSeg('att-scope', () => openAttachments());
bindSeg('att-filter', () => renderAttachments2());
$('doc-close').onclick = () => ($('doc-viewer').hidden = true);
$('doc-viewer').addEventListener('click', (e) => {
  if (e.target.id === 'doc-viewer') $('doc-viewer').hidden = true;
});

$('edit-btn').onclick = () => setEditMode(!editMode);

$('settings-btn').onclick = () => sendTo(ownHostId(), { type: 'get_settings' });
$('settings-cancel').onclick = () => ($('settings').hidden = true);
$('settings').addEventListener('click', (e) => {
  if (e.target.id === 'settings') $('settings').hidden = true;
});
$('settings-save').onclick = () => {
  send({
    type: 'set_settings',
    userName: $('set-username').value.trim(),
    projectsRoot: $('set-root').value.trim(),
  });
  $('settings').hidden = true;
};

// chat search — filtering over the cached last state
$('search').addEventListener('input', () => {
  renderSidebar(); // instant: filter the chats already on screen
  clearTimeout(searchTimer); // then, after a pause, ask the host to dig through disk
  searchTimer = setTimeout(() => runSearch(false), 400);
});

// Safari ignores user-scalable=no in a tab — suppress pinch manually.
// Images are viewed in the lightbox anyway, so zoom is not needed.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend'])
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// PWA: service worker (needed for install and push)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Tell the host which chat this client is actually looking at, so it can push a
// notification when a task finishes with nobody watching that chat.
function reportFocus() {
  const watching = document.visibilityState === 'visible' ? activeChatId : null;
  if (activeChatId) sendTo(chatHostId(activeChatId), { type: 'focus', chatId: watching });
  // going away may mean eviction: save the transcript while we still can
  if (!watching && activeChatId) cacheTranscript(activeChatId);
}
document.addEventListener('visibilitychange', reportFocus);

// push notifications — relay only (localhost has no subscription backend)
function notifyStatus(text, ok = false) {
  const node = $('notify-status');
  node.textContent = text;
  node.className = ok ? 'ok' : text ? 'warn' : '';
}

$('notify-btn').onclick = async function () {
  try {
    notifyStatus('');
    const keyRes = await fetch('/api/push/key');
    if (!keyRes.ok) throw new Error('notifications only work through the relay, not on localhost');
    const { publicKey } = await keyRes.json();

    // A blocked site never sees a prompt again: requestPermission returns
    // "denied" instantly, so say where to undo it instead of blaming the user.
    if (Notification.permission === 'denied')
      throw new Error('notifications are blocked for this site — allow them in the browser’s site settings (padlock icon in the address bar), then press again');
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted')
      throw new Error('permission dismissed — press again and choose “Allow”');

    const reg = await navigator.serviceWorker.ready;
    const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey }));
    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!saveRes.ok) throw new Error('the relay did not accept the subscription');
    this.textContent = '🔔 Notifications enabled ✓';
    notifyStatus('this device will get notifications', true);
  } catch (e) {
    notifyStatus(e.message);
  }
};

$('restart-server').onclick = () => {
  // no confirmation: open chats reopen themselves, so a restart costs nothing
  sendTo(ownHostId(), { type: 'restart_server' });
  $('settings').hidden = true;
};

setModeSelect($('permission-mode').value); // highlight bypass on startup

$('hide-tools').checked = localStorage.getItem('hideTools') === '1';
feedHost.classList.toggle('hide-tools', $('hide-tools').checked);
$('hide-tools').addEventListener('change', function () {
  localStorage.setItem('hideTools', this.checked ? '1' : '0');
  feedHost.classList.toggle('hide-tools', this.checked);
});

bootFromCache();
connect();
