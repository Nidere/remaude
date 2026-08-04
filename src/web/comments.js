// Inline comments in the document viewer: select text → comment → thread,
// Confluence-style. Anchors are quotes with a little context, matched against
// the rendered text — line numbers die on the first rewrite, quotes survive.
// Everything here goes into the DOM via textContent or mdToHtml (which escapes
// all input), never raw — comment text is other people's text.
import { mdToHtml } from './md.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

let request = () => {}; // wired to the hosts by app.js

/** Every command goes to the host the open document came from. */
const ask = (obj) => request(obj, doc.hostId);

// ---------- state ----------

const doc = {
  path: null,
  hostId: null, // documents may come from any connected host, not just the active chat's
  html: '', // the rendered markdown, kept so highlights can be re-applied from scratch
  threads: [],
  seen: {}, // threadId -> my last-seen ts (server truth, optimistically bumped)
  me: null,
  located: new Map(), // threadId -> did the anchor match the current text
  pendingLlm: new Set(),
};
const badges = new Map(); // hostKey -> {total, perDoc}
let openThreadId = null; // thread shown in the popover
let draftAnchor = null; // selection waiting to become a new thread
let popAnchorEl = null; // the element the popover is pinned to

const threadById = (id) => doc.threads.find((t) => t.id === id);

function threadUnseen(t) {
  return (t.replies ?? []).some((r) => r.authorId !== doc.me && r.createdAt > (doc.seen[t.id] ?? 0));
}

// ---------- wiring ----------

export function initDocComments(ctx) {
  request = ctx.request;
  buildUi();
}

/** The viewer just rendered a document — fetch its threads. */
export function docOpened(path, html, hostId) {
  doc.path = path;
  doc.hostId = hostId ?? null;
  doc.html = html;
  doc.threads = [];
  doc.seen = {};
  doc.located.clear();
  doc.pendingLlm.clear();
  closePop();
  hideAddBtn();
  hideList();
  updateThreadsBtn();
  ask({ type: 'list_comments', path });
}

export function onComments({ path, threads, seen, me }) {
  if (!doc.path || path.toLowerCase() !== doc.path.toLowerCase()) return;
  doc.threads = threads ?? [];
  // per-thread the freshest mark wins: the server may know about a look from
  // another device, the optimistic local mark may be newer than the echo
  const merged = { ...(seen ?? {}) };
  for (const [id, ts] of Object.entries(doc.seen)) merged[id] = Math.max(merged[id] ?? 0, ts);
  doc.seen = merged;
  doc.me = me;
  // a pending "Claude is thinking" row disappears as soon as his reply is here
  for (const id of [...doc.pendingLlm])
    if (threadById(id)?.replies.some((r) => r.role === 'assistant')) doc.pendingLlm.delete(id);
  if (!$('doc-viewer').hidden) {
    renderHighlights();
    if (openThreadId) {
      const open = threadById(openThreadId);
      if (open) {
        renderPop();
        // a reply landing in a thread the person is looking at is read on arrival
        if (!$('cmt-pop').hidden && threadUnseen(open)) {
          doc.seen[open.id] = Date.now();
          ask({ type: 'mark_thread_seen', path: doc.path, threadId: open.id });
          refreshMarkClasses();
          updateThreadsBtn();
        }
      } else closePop(); // the thread was deleted under us
    }
  }
}

export function onLlmDone({ path, threadId }) {
  doc.pendingLlm.delete(threadId);
  if (doc.path && path.toLowerCase() === doc.path.toLowerCase() && openThreadId === threadId) renderPop();
}

export function onBadge(msg) {
  badges.set(msg._host ?? 'local', { total: msg.total ?? 0, perDoc: msg.perDoc ?? {} });
  refreshBadges();
}

export function unseenForDoc(path) {
  for (const b of badges.values()) {
    const n = b.perDoc[path];
    if (n) return n;
  }
  return 0;
}

/** Red dots: on the inbox button and on document rows currently on screen. */
export function refreshBadges() {
  let total = 0;
  for (const b of badges.values()) total += b.total;
  $('att-btn').classList.toggle('has-unseen', total > 0);
  document
    .querySelectorAll('.att-doc[data-path]')
    .forEach((row) => row.classList.toggle('has-unseen', unseenForDoc(row.dataset.path) > 0));
}

// ---------- anchors: rendered text ↔ DOM positions ----------

/** Flatten the rendered document into one string plus a map back to its text nodes. */
function textIndex(root) {
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { nodes, text };
}

/** A selection endpoint (node + offset) → offset in the flattened text. */
function pointToOffset(idx, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = idx.nodes.find((e) => e.node === container);
    return entry ? entry.start + Math.min(offset, container.nodeValue.length) : null;
  }
  const ref = container.childNodes[offset];
  if (ref) {
    for (const e of idx.nodes)
      if (
        ref === e.node ||
        (ref.nodeType === Node.ELEMENT_NODE && ref.contains(e.node)) ||
        ref.compareDocumentPosition(e.node) & Node.DOCUMENT_POSITION_FOLLOWING
      )
        return e.start;
    return idx.text.length;
  }
  let last = null;
  for (const e of idx.nodes) if (container.contains(e.node)) last = e;
  return last ? last.start + last.node.nodeValue.length : null;
}

/** Where the quote lives now — best match by surrounding context, or null if it is gone. */
function locate(idx, anchor) {
  const quote = anchor?.quote ?? '';
  if (!quote) return null;
  const hits = [];
  for (let i = idx.text.indexOf(quote); i !== -1 && hits.length < 64; i = idx.text.indexOf(quote, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const backMatch = (a, b) => {
    let k = 0;
    while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
    return k;
  };
  const foreMatch = (a, b) => {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  };
  let best = hits[0];
  let bestScore = -1;
  for (const pos of hits) {
    const before = idx.text.slice(Math.max(0, pos - (anchor.prefix ?? '').length), pos);
    const after = idx.text.slice(pos + quote.length, pos + quote.length + (anchor.suffix ?? '').length);
    const score = backMatch(before, anchor.prefix ?? '') + foreMatch(after, anchor.suffix ?? '');
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}

/** Wrap [start, end) of the flattened text in <mark> elements, splitting text nodes as needed. */
function wrapRange(idx, start, end, threadId) {
  for (const entry of idx.nodes) {
    const len = entry.node.nodeValue.length;
    const s = Math.max(0, start - entry.start);
    const e = Math.min(len, end - entry.start);
    if (e <= s) continue;
    let node = entry.node;
    if (s > 0) node = node.splitText(s);
    if (e - s < node.nodeValue.length) node.splitText(e - s);
    const mark = document.createElement('mark');
    mark.className = 'doc-hl';
    mark.dataset.thread = threadId;
    node.parentNode.replaceChild(mark, node);
    mark.append(node);
  }
}

function renderHighlights() {
  const body = $('doc-body');
  body.innerHTML = doc.html; // start clean: marks from the previous state are gone
  doc.located.clear();
  for (const t of doc.threads) {
    if (t.resolved) continue; // resolved threads live in the list only
    const idx = textIndex(body);
    const pos = locate(idx, t.anchor);
    doc.located.set(t.id, pos != null);
    if (pos != null) wrapRange(idx, pos, pos + t.anchor.quote.length, t.id);
  }
  refreshMarkClasses();
  updateThreadsBtn();
}

function refreshMarkClasses() {
  document.querySelectorAll('mark.doc-hl').forEach((m) => {
    const t = threadById(m.dataset.thread);
    m.classList.toggle('unseen', Boolean(t && threadUnseen(t)));
    m.classList.toggle('active', m.dataset.thread === openThreadId);
  });
}

// ---------- the "add comment" button over a selection ----------

let selTimer = null;
// The anchor is taken while the selection is still there, not when the button
// is pressed: some browsers drop the selection on mousedown, and then pressing
// "comment" did nothing at all, silently.
let pendingAnchor = null;

function maybeShowAddBtn() {
  const btn = $('cmt-add');
  const sel = getSelection();
  if (!doc.path || $('doc-viewer').hidden || !sel || sel.isCollapsed || !sel.rangeCount) return hideAddBtn();
  const range = sel.getRangeAt(0);
  if (!$('doc-body').contains(range.commonAncestorContainer)) return hideAddBtn();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return hideAddBtn();
  pendingAnchor = captureAnchor();
  if (!pendingAnchor) return hideAddBtn(); // nothing we could attach a thread to
  btn.hidden = false;
  btn.style.left = Math.min(Math.max(rect.left + rect.width / 2 - 60, 8), innerWidth - 130) + 'px';
  btn.style.top = Math.min(rect.bottom + 8, innerHeight - 44) + 'px';
}

function hideAddBtn() {
  $('cmt-add').hidden = true;
  pendingAnchor = null;
}

function captureAnchor() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const idx = textIndex($('doc-body'));
  const start = pointToOffset(idx, range.startContainer, range.startOffset);
  const end = pointToOffset(idx, range.endContainer, range.endOffset);
  if (start == null || end == null || end - start < 1) return null;
  const quote = idx.text.slice(start, end).slice(0, 1000);
  return {
    quote,
    prefix: idx.text.slice(Math.max(0, start - 40), start),
    suffix: idx.text.slice(start + quote.length, start + quote.length + 40),
    rect: range.getBoundingClientRect(),
  };
}

// ---------- popover: one thread (or a draft) ----------

function openThread(threadId, anchorEl) {
  const t = threadById(threadId);
  if (!t) return;
  openThreadId = threadId;
  draftAnchor = null;
  popAnchorEl = anchorEl ?? null;
  renderPop();
  if (threadUnseen(t)) {
    doc.seen[threadId] = Date.now(); // optimistic — the dot dies right away
    ask({ type: 'mark_thread_seen', path: doc.path, threadId });
    refreshMarkClasses();
    renderThreadList();
  }
}

function openDraft(anchor) {
  draftAnchor = anchor;
  openThreadId = null;
  popAnchorEl = null;
  renderPop(anchor.rect);
  $('cmt-pop').querySelector('textarea')?.focus();
}

function closePop() {
  $('cmt-pop').hidden = true;
  openThreadId = null;
  draftAnchor = null;
  popAnchorEl = null;
  refreshMarkClasses();
}

function placePop(rect) {
  const pop = $('cmt-pop');
  pop.hidden = false;
  if (matchMedia('(max-width: 768px)').matches) return; // the bottom sheet is pure CSS
  const width = Math.min(380, innerWidth - 24);
  pop.style.width = width + 'px';
  pop.style.left = Math.min(Math.max(rect.left, 12), innerWidth - width - 12) + 'px';
  if (rect.bottom + 300 > innerHeight && rect.top > 320) {
    pop.style.top = 'auto';
    pop.style.bottom = innerHeight - rect.top + 8 + 'px';
  } else {
    pop.style.bottom = 'auto';
    pop.style.top = rect.bottom + 8 + 'px';
  }
}

function replyRow(t, r) {
  const row = el('div', `cmt-reply${r.role === 'assistant' ? ' llm' : ''}`, '');
  const head = el('div', 'cmt-reply-head', '');
  head.append(el('span', 'cmt-author', r.role === 'assistant' ? `🤖 ${r.author}` : r.author));
  const when = new Date(r.createdAt).toLocaleString();
  head.append(el('span', 'cmt-time', r.editedAt ? `${when} · edited` : when));
  const mine = r.authorId === doc.me;
  if (mine || doc.me === '@owner') {
    const actions = el('span', 'cmt-actions', '');
    if (mine) {
      const edit = el('button', '', '✎');
      edit.title = 'edit';
      edit.onclick = () => startEdit(t, r, row);
      actions.append(edit);
    }
    const del = el('button', '', '✕');
    del.title = t.replies[0].id === r.id ? 'delete the whole thread' : 'delete reply';
    del.onclick = () => {
      const whole = t.replies[0].id === r.id;
      if (!confirm(whole ? 'Delete this thread with all its replies?' : 'Delete this reply?')) return;
      ask({ type: 'delete_comment', path: doc.path, threadId: t.id, replyId: r.id });
      if (whole) closePop();
    };
    actions.append(del);
    head.append(actions);
  }
  const body = el('div', 'cmt-text md-body', '');
  body.innerHTML = mdToHtml(r.text); // mdToHtml escapes everything — safe for other people's text
  row.append(head, body);
  return row;
}

function startEdit(t, r, row) {
  const body = row.querySelector('.cmt-text');
  const area = el('textarea', 'cmt-edit-area', '');
  area.value = r.text;
  const actions = el('div', 'cmt-compose-row', '');
  const save = el('button', 'cmt-primary', 'Save');
  save.onclick = () => {
    const text = area.value.trim();
    if (text && text !== r.text) ask({ type: 'edit_comment', path: doc.path, threadId: t.id, replyId: r.id, text });
    else renderPop();
  };
  const cancel = el('button', '', 'Cancel');
  cancel.onclick = () => renderPop();
  actions.append(save, cancel);
  body.replaceWith(area, actions);
  area.focus();
}

function renderPop(rectOverride) {
  const pop = $('cmt-pop');
  pop.innerHTML = '';
  const t = openThreadId ? threadById(openThreadId) : null;

  const head = el('div', 'cmt-head', '');
  const quote = t?.anchor?.quote ?? draftAnchor?.quote ?? '';
  if (quote) head.append(el('div', 'cmt-quote', quote.length > 140 ? quote.slice(0, 140) + '…' : quote));
  const headActions = el('div', 'cmt-head-actions', '');
  if (t) {
    const resolve = el('button', t.resolved ? 'resolved' : '', t.resolved ? '↺ Reopen' : '✓ Resolve');
    resolve.title = t.resolved ? 'reopen this thread' : 'mark as resolved';
    resolve.onclick = () => ask({ type: 'resolve_comment', path: doc.path, threadId: t.id, resolved: !t.resolved });
    headActions.append(resolve);
  }
  const close = el('button', '', '✕');
  close.onclick = closePop;
  headActions.append(close);
  head.append(headActions);
  pop.append(head);

  if (t && !t.resolved && doc.located.get(t.id) === false)
    pop.append(el('div', 'cmt-orphan', '⚠ the quoted fragment has changed or is gone from the text'));

  if (t) {
    const list = el('div', 'cmt-replies', '');
    for (const r of t.replies) list.append(replyRow(t, r));
    if (doc.pendingLlm.has(t.id)) {
      const wait = el('div', 'cmt-reply llm pending', '');
      wait.append(el('div', 'cmt-text', '🤖 Claude is thinking…'));
      list.append(wait);
    }
    pop.append(list);
    list.scrollTop = list.scrollHeight;
  }

  const composer = el('div', 'cmt-composer', '');
  const area = el('textarea', '', '');
  area.placeholder = t ? 'reply…' : 'what about this fragment?';
  area.rows = 2;
  const row = el('div', 'cmt-compose-row', '');
  const submit = el('button', 'cmt-primary', t ? 'Reply' : 'Comment');
  submit.onclick = () => {
    const text = area.value.trim();
    if (!text) return;
    if (t) ask({ type: 'reply_comment', path: doc.path, threadId: t.id, text });
    else {
      if (!draftAnchor) return closePop(); // the draft's anchor is gone — nothing to attach to
      const { quote: q, prefix, suffix } = draftAnchor;
      ask({ type: 'add_comment', path: doc.path, anchor: { quote: q, prefix, suffix }, text });
      getSelection()?.removeAllRanges();
      closePop();
      return;
    }
    area.value = '';
  };
  row.append(submit);
  if (t) {
    const askBtn = el('button', 'cmt-llm', '🤖 Ask Claude');
    askBtn.title = 'send the thread (and your question, if typed) to the document’s chat';
    askBtn.onclick = () => {
      ask({ type: 'ask_llm_comment', path: doc.path, threadId: t.id, text: area.value.trim() });
      doc.pendingLlm.add(t.id);
      area.value = '';
      renderPop();
    };
    row.append(askBtn);
  }
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit.click();
    }
  });
  composer.append(area, row);
  pop.append(composer);

  // a re-render of the highlights detaches the mark this popover was pinned to —
  // a detached element measures as (0,0) and would drag the popover into the corner
  if (popAnchorEl && !popAnchorEl.isConnected)
    popAnchorEl = document.querySelector(`mark.doc-hl[data-thread="${openThreadId}"]`);
  const rect =
    rectOverride ??
    popAnchorEl?.getBoundingClientRect() ??
    document.querySelector(`mark.doc-hl[data-thread="${openThreadId}"]`)?.getBoundingClientRect() ??
    $('doc-threads').getBoundingClientRect();
  if (rect.width || rect.height || rect.top || rect.left) placePop(rect);
  else pop.hidden = false; // nothing sane to pin to — keep whatever position it had
  refreshMarkClasses();
}

// ---------- the threads list under the 💬 button ----------

function updateThreadsBtn() {
  const btn = $('doc-threads');
  const n = doc.threads.length;
  btn.hidden = !doc.path || !n;
  if (!n) return hideList();
  btn.textContent = `💬 ${n}`;
  btn.classList.toggle('has-unseen', doc.threads.some(threadUnseen));
}

function hideList() {
  $('cmt-list').hidden = true;
}

function renderThreadList() {
  const list = $('cmt-list');
  list.innerHTML = '';
  const order = [...doc.threads].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt - a.createdAt);
  for (const t of order) {
    const row = el('div', `cmt-list-item${t.resolved ? ' resolved' : ''}`, '');
    const icon = t.resolved ? '✓' : doc.located.get(t.id) === false ? '⚠' : '💬';
    row.append(el('span', `cmt-list-icon${threadUnseen(t) ? ' unseen' : ''}`, icon));
    const info = el('div', 'cmt-list-info', '');
    const quote = (t.anchor?.quote ?? '').replace(/\s+/g, ' ');
    info.append(el('div', 'cmt-list-quote', quote.length > 60 ? quote.slice(0, 60) + '…' : quote || '—'));
    const last = t.replies[t.replies.length - 1];
    info.append(el('div', 'cmt-list-meta', `${t.replies.length} · ${last.author}: ${last.text.slice(0, 40)}`));
    row.append(info);
    row.onclick = () => {
      hideList();
      const mark = document.querySelector(`mark.doc-hl[data-thread="${t.id}"]`);
      if (mark) {
        mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
        openThread(t.id, mark);
      } else {
        openThread(t.id, $('doc-threads')); // resolved or orphaned: pin to the button
      }
    };
    list.append(row);
  }
  const btn = $('doc-threads').getBoundingClientRect();
  list.style.top = btn.bottom + 6 + 'px';
  list.style.right = Math.max(8, innerWidth - btn.right) + 'px';
  list.hidden = false;
}

// ---------- one-time UI ----------

function buildUi() {
  const addBtn = el('button', '', '💬 Comment');
  addBtn.id = 'cmt-add';
  addBtn.hidden = true;
  // mousedown would collapse the selection before click ever fires
  addBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  addBtn.onclick = () => {
    const anchor = pendingAnchor ?? captureAnchor(); // whichever still exists
    hideAddBtn();
    if (anchor) openDraft(anchor);
    else showError('could not tell which fragment that was — select it again');
  };
  const pop = el('div', '', '');
  pop.id = 'cmt-pop';
  pop.hidden = true;
  const list = el('div', '', '');
  list.id = 'cmt-list';
  list.hidden = true;
  document.body.append(addBtn, pop, list);

  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(maybeShowAddBtn, 250);
  });

  $('doc-body').addEventListener('click', (e) => {
    const mark = e.target.closest('mark.doc-hl');
    if (mark) {
      e.stopPropagation();
      openThread(mark.dataset.thread, mark);
    }
  });

  $('doc-threads').onclick = (e) => {
    e.stopPropagation();
    if (!$('cmt-list').hidden) return hideList();
    renderThreadList();
  };

  // the popover follows its highlight while the document scrolls under it
  $('doc-body').addEventListener('scroll', () => {
    if ($('cmt-pop').hidden || !popAnchorEl?.isConnected) return;
    placePop(popAnchorEl.getBoundingClientRect());
  });

  // Clicking anywhere else puts the popover and the list away. Two traps here:
  // a button whose handler re-rendered the popover arrives at document as a
  // detached node (closest() finds nothing — it must not read as "outside"),
  // and the click that opens a thread FROM the list must not then close it.
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.isConnected) return;
    if (!$('cmt-list').hidden && !e.target.closest('#cmt-list, #doc-threads')) hideList();
    if (!$('cmt-pop').hidden && !e.target.closest('#cmt-pop, #cmt-add, #cmt-list, mark.doc-hl')) closePop();
  });

  // the popover, the list and the add button belong to the document — none of
  // them may outlive the viewer (they float over the whole app otherwise)
  new MutationObserver(() => {
    if (!$('doc-viewer').hidden) return;
    doc.path = null;
    closePop();
    hideList();
    hideAddBtn();
  }).observe($('doc-viewer'), { attributes: true, attributeFilter: ['hidden'] });
}

/** A soft error strip instead of alert(): a modal dialog over a PWA feels like a freeze. */
export function showError(message) {
  const pop = $('cmt-pop');
  const host = !pop.hidden ? pop : !$('doc-viewer').hidden ? $('doc-box') : null;
  const strip = el('div', 'cmt-error', message);
  if (host) host.prepend(strip);
  else document.body.append(strip);
  setTimeout(() => strip.remove(), 6000);
}
