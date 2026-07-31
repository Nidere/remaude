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
let cachedProjects = [];
const chats = new Map(); // chatId -> {projectPath, status, feedEl, streamEl, streamText, chips:Map, subagents:Map, historyRequested}
const attachments = []; // {mediaType, data(base64), url}

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
  state({ projects, guest }) {
    cachedProjects = projects;
    document.body.classList.toggle('guest', Boolean(guest));
    renderSidebar(projects);
    // after a page reload we return to the last open chat;
    // after a server restart the ids differ — look it up by session id
    if (!activeChatId) {
      const last = localStorage.getItem('lastChat');
      if (last && chats.has(last)) selectChat(last);
      else {
        const lastSession = localStorage.getItem('lastSession');
        if (lastSession) {
          for (const [id, chat] of chats) {
            if (chat.sessionId === lastSession) {
              selectChat(id);
              break;
            }
          }
        }
      }
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
    if (chat) chat.status = status;
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
      send({ type: 'permission_response', requestId, result: { behavior: 'allow', updatedInput: input } });
    deny.onclick = () =>
      send({ type: 'permission_response', requestId, result: { behavior: 'deny', message: 'Denied by the user' } });
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
    for (const m of messages) renderSdkMessage(chatId, m);
    if (chatId === activeChatId) scrollToBottom(true);
  },

  root_listing({ root, dirs, added, error }) {
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
              onclick: isAdded ? null : () => send({ type: 'add_from_root', name }),
            };
          })
    );
  },

  sessions({ projectPath, sessions, live }) {
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
                  send({
                    type: 'open_session',
                    projectPath,
                    sessionId: s.id,
                    permissionMode: $('permission-mode').value,
                  }),
          }))
        : [{ label: 'no saved sessions', muted: true }]
    );
  },

  share_result({ chatId, emails }) {
    alert(emails.length ? `Chat access: ${emails.join(', ')}` : 'Access revoked for everyone');
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
  send({ type: 'history', chatId });
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
  $('input').value = chat.draftText ?? '';
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
  cur.unread = 0;
  updateChatItem(chatId);
  updateTabState();
  syncHeaderSelects(cur);
  closeSidebar();
  if (hasKeyboard) $('input').focus();
  scrollToBottom(true);
}

function syncHeaderSelects(chat) {
  const shortModel = (chat.model ?? '').replace(/^claude-/, '').replace(/-[\d.]+.*$/, '');
  $('model-select').value = ['fable', 'opus', 'sonnet', 'haiku'].includes(shortModel) ? shortModel : '';
  // the effective effort comes from the server in chat_meta (override or host default)
  $('effort-select').value = ['low', 'medium', 'high', 'xhigh', 'max'].includes(chat.effort) ? chat.effort : '';
}

// ---------- rendering SDK messages ----------

function renderSdkMessage(chatId, msg) {
  const chat = getChat(chatId);

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
    // an ordinary user message
    const bubble = el('div', 'msg msg-user', '');
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

function openModal(title, items) {
  $('picker-title').textContent = title;
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

function renderSidebar(projects) {
  const root = $('projects');
  root.innerHTML = '';
  for (const p of projects) {
    const proj = el('div', 'project', '');

    const head = el('div', 'project-head', '');
    const name = el('span', 'project-name', p.path.split(/[\\/]/).filter(Boolean).pop());
    name.title = p.path;
    const actions = el('span', 'project-actions', '');
    const btnNew = el('button', '', '+');
    btnNew.title = 'new chat';
    btnNew.onclick = () => send({ type: 'create_chat', projectPath: p.path, permissionMode: $('permission-mode').value });
    const btnOld = el('button', '', '⏳');
    btnOld.title = 'past chats';
    btnOld.onclick = () => send({ type: 'list_sessions', projectPath: p.path });
    const btnClose = el('button', 'project-close', '✕');
    btnClose.title = 'remove project from the sidebar (files and sessions stay)';
    btnClose.onclick = () => {
      if (confirm(`Remove “${shortPath(p.path)}” from the sidebar? Open chats will close; nothing is deleted on disk.`))
        send({ type: 'close_project', path: p.path });
    };
    actions.append(btnNew, btnOld, btnClose);
    head.append(name, actions);
    proj.append(head);

    const filter = $('search').value.trim().toLowerCase();
    let visibleChats = 0;
    for (const c of p.chats) {
      const chat = getChat(c.id, p.path);
      chat.status = c.status;
      chat.title = c.title;
      chat.sessionId = c.sessionId;
      if (c.model) chat.model = c.model;
      if (c.permissionMode) chat.mode = c.permissionMode;
      const labelText = c.title ?? (c.sessionId ? c.id.slice(0, 8) : 'new');
      if (filter && !labelText.toLowerCase().includes(filter) && !p.path.toLowerCase().includes(filter)) continue;
      visibleChats++;

      const item = el('div', 'chat-item', '');
      item.dataset.chatId = c.id;
      const dot = el('span', `status-dot ${c.status}`, '');
      const label = el('span', 'chat-label', labelText);
      item.append(dot, label);

      if (chat.unread) {
        item.classList.add('unread');
        item.append(el('span', 'unread-badge', String(chat.unread)));
      }

      const actions = el('span', 'chat-actions', '');
      const btnRename = el('button', '', '✏');
      btnRename.title = 'rename';
      btnRename.onclick = (e) => {
        e.stopPropagation();
        const name = prompt('Chat name:', c.title ?? '');
        if (name?.trim()) send({ type: 'rename_chat', chatId: c.id, title: name.trim() });
      };
      const btnHide = el('button', '', '✕');
      btnHide.title = 'close chat (the session stays on disk)';
      btnHide.onclick = (e) => {
        e.stopPropagation();
        if (confirm('Close this chat? The session stays — reopen it via “past chats”.'))
          send({ type: 'hide_chat', chatId: c.id });
      };
      actions.append(btnRename, btnHide);
      item.append(actions);

      if (c.id === activeChatId) item.classList.add('active');
      item.onclick = () => selectChat(c.id);
      proj.append(item);
    }
    if (filter && !visibleChats && !p.path.toLowerCase().includes(filter)) continue;
    root.append(proj);
  }
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
  send({ type: 'send', chatId: activeChatId, content });
  $('input').value = '';
  autoGrowInput($('input'));
  attachments.length = 0;
  renderAttachments();
  const chat = chats.get(activeChatId);
  if (chat) {
    chat.draftText = '';
    chat.draftAtt = [];
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
$('stop-btn').onclick = () => activeChatId && send({ type: 'interrupt', chatId: activeChatId });

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

$('pick-project').onclick = () => send({ type: 'list_root' });
$('picker-cancel').onclick = () => ($('picker').hidden = true);
$('picker').addEventListener('click', (e) => {
  if (e.target.id === 'picker') $('picker').hidden = true;
});

$('add-project-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const path = $('add-project-path').value.trim();
  if (!path) return;
  send({ type: 'add_project', path });
  $('add-project-path').value = '';
});

$('permission-mode').addEventListener('change', function () {
  setModeSelect(this.value);
  if (activeChatId) send({ type: 'set_permission_mode', chatId: activeChatId, mode: this.value });
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
$('share-btn').onclick = () => {
  if (!activeChatId) return;
  const email = prompt('Who gets access (email)? Empty string revokes access for everyone:');
  if (email === null) return;
  if (email.trim()) send({ type: 'share_chat', chatId: activeChatId, email: email.trim() });
  else send({ type: 'unshare_chat', chatId: activeChatId });
};

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
  if (activeChatId && this.value) send({ type: 'set_model', chatId: activeChatId, model: this.value });
});
$('effort-select').addEventListener('change', function () {
  if (activeChatId && this.value) send({ type: 'set_effort', chatId: activeChatId, effort: this.value });
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

$('claude-login-btn').onclick = () => send({ type: 'claude_login_start' });
$('claude-login-send').onclick = () => {
  const code = $('claude-login-code').value.trim();
  if (code) send({ type: 'claude_login_code', code });
};

function renderRelayStatus(relay) {
  const node = $('relay-status');
  if (!node) return;
  $('set-relay-url').value = relay?.url ?? '';
  $('set-relay-url').parentElement.hidden = Boolean(relay?.paired); // once paired there is no reason to change the address
  if (!relay?.paired) node.textContent = 'relay: not paired';
  else node.textContent = relay.connected ? 'relay: connected ✓' : 'relay: paired, no connection…';
  node.className = relay?.connected ? 'ok' : '';
}

$('pair-btn').onclick = () => {
  const code = $('set-pair-code').value.trim();
  if (!code) return;
  send({ type: 'pair_relay', code, url: $('set-relay-url').value.trim() || undefined });
  $('set-pair-code').value = '';
};

$('settings-btn').onclick = () => send({ type: 'get_settings' });
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
$('search').addEventListener('input', () => renderSidebar(cachedProjects));

// Safari ignores user-scalable=no in a tab — suppress pinch manually.
// Images are viewed in the lightbox anyway, so zoom is not needed.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend'])
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// PWA: service worker (needed for install and push)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// push notifications — relay only (localhost has no subscription backend)
$('notify-btn').onclick = async function () {
  try {
    const keyRes = await fetch('/api/push/key');
    if (!keyRes.ok) throw new Error('notifications work only via relay (not on localhost)');
    const { publicKey } = await keyRes.json();
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('notification permission was not granted');
    const reg = await navigator.serviceWorker.ready;
    const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!saveRes.ok) throw new Error('could not save the subscription');
    this.textContent = '🔔 Notifications enabled ✓';
  } catch (e) {
    alert(e.message);
  }
};

$('restart-server').onclick = () => {
  if (confirm('Restart the server? Live chats will close (resumable via “past chats”).')) {
    send({ type: 'restart_server' });
    $('settings').hidden = true;
  }
};

setModeSelect($('permission-mode').value); // highlight bypass on startup

$('hide-tools').checked = localStorage.getItem('hideTools') === '1';
feedHost.classList.toggle('hide-tools', $('hide-tools').checked);
$('hide-tools').addEventListener('change', function () {
  localStorage.setItem('hideTools', this.checked ? '1' : '0');
  feedHost.classList.toggle('hide-tools', this.checked);
});

connect();
