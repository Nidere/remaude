// What an invited person sees before they have clicked anything.
//
// Guest mode used to be decided by the open chat, so someone who had just
// signed in — nothing open, "pick or start a chat" — was handed the owner's
// controls: the bypass switch, the model and effort pickers, the limits, "add
// host". And a project shared whole came with no way to start a chat in it,
// although the host sends the permission and honours it.
//
// The second half checks the other direction: an owner who also has shared
// chats keeps everything, and loses it only while reading someone else's chat.
//
// And a chat with two people in it has to read like one: the reader's own
// messages down the right, everybody else's down the left. Who "the reader" is
// depends on the machine — the same person is the owner of one and a guest of
// another — so the side is decided by the identity that machine gave them.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const PORT = 7781;

const OWNER_PROJECT = 'C:\\Users\\Nidere\\Documents\\Projects\\mine';
const SHARED_PROJECT = 'C:\\Users\\Nikita\\wiki';
const CLOSED_PROJECT = 'C:\\Users\\Nikita\\secrets'; // a single chat shared out of it, nothing more

// The host's own list, copied from src/host/server.js. Anything else a guest
// sends comes back as an error in their feed — so the UI must not send it.
const GUEST_TYPES = new Set([
  'send', 'history', 'focus', 'create_chat', 'list_sessions', 'open_session', 'attachments', 'image',
  'tool_result', 'upload_file', 'save_draft', 'create_thread', 'open_doc_link', 'list_dir', 'add_artifact',
  'read_artifact', 'list_comments', 'add_comment', 'reply_comment', 'edit_comment', 'delete_comment',
  'resolve_comment', 'mark_thread_seen', 'ask_llm_comment',
]);

const READER = 'me@nidere.com'; // whoever is looking, on whichever machine
const THEM = 'ostapcove@nidere.com';

let mode = 'guest'; // or 'mixed' — flipped between page loads
const asked = [];

// the same two people in every chat, so the side is the only thing that changes
const said = (author, authorId, text) => ({
  type: 'user',
  author,
  authorId,
  message: { role: 'user', content: text },
  timestamp: new Date().toISOString(),
});
const HISTORY = [
  said('Никита', '@owner', 'от владельца машины'),
  said('me', READER, 'от того, кто смотрит'),
  said('ostapcove', THEM, 'от другого гостя'),
];

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

const guestChat = (id, title) => ({ id, sessionId: `s-${id}`, status: 'idle', title, model: 'opus' });

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const say = (o) => ws.send(JSON.stringify(o));
  const hosts = [{ id: 'host-them', name: 'NIKITA-PC', owner: 'nikita@nidere.com', own: false }];
  if (mode === 'mixed') hosts.unshift({ id: 'host-mine', name: 'MY-PC', owner: 'me@nidere.com', own: true });
  say({ type: 'hosts', hosts });

  if (mode === 'mixed')
    say({
      type: 'state',
      _host: 'host-mine',
      me: '@owner', // on our own machine we are the owner
      projects: [{ path: OWNER_PROJECT, name: null, chats: [guestChat('chat-mine', 'мой чат')] }],
    });

  // someone else's machine: a project shared whole, and a lone shared chat
  say({
    type: 'state',
    _host: 'host-them',
    guest: true,
    me: READER, // on theirs we are one of the guests

    projects: [
      { path: SHARED_PROJECT, name: null, canCreate: true, chats: [guestChat('chat-shared', 'общий чат')] },
      { path: CLOSED_PROJECT, name: null, canCreate: false, chats: [guestChat('chat-single', 'один чат')] },
    ],
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    asked.push({ type: m.type, host: m._host ?? null, body: m });
    // someone else's machine refuses everything a guest has no business asking
    if ((m._host ?? 'host-them') === 'host-them' && !GUEST_TYPES.has(m.type)) {
      say({ type: 'error', message: 'only the host owner can do that', inResponseTo: m.type });
      return;
    }
    if (m.type === 'history') say({ type: 'history', chatId: m.chatId, messages: HISTORY });
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (n) => console.log('ok:', n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (sel) =>
  page.evaluate(
    `(() => { const n = document.querySelector(${JSON.stringify(sel)}); return Boolean(n && n.offsetParent !== null); })()`
  );
/** Which side a message sits on, found by what it says. */
const sideOf = (text) =>
  page.evaluate(
    `(() => {
      const b = [...document.querySelectorAll('.msg-user')].find((n) => n.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'missing';
      return b.classList.contains('msg-them') ? 'left' : 'right';
    })()`
  );

/** Everyone in the chat, and where they ended up. */
async function checkSides(where, expected) {
  for (const [text, side] of Object.entries(expected)) {
    const got = await sideOf(text);
    if (got !== side) await fail(`${where}: "${text}" is ${got}, expected ${side}`);
  }
  ok(`${where}: ${Object.entries(expected).map(([t, s]) => `${t} ${s}`).join(', ')}`);
}

/** The "+" on the row of a project, whoever drew it. */
const plusOf = (path) =>
  page.evaluate(
    `(() => {
      const name = [...document.querySelectorAll('.project-name')].find((n) => n.title === ${JSON.stringify(path)});
      if (!name) return 'no row for the project';
      const btn = [...name.parentElement.querySelectorAll('button')].find((b) => b.title === 'new chat');
      if (!btn) return 'none';
      return btn.offsetParent === null ? 'hidden' : 'shown';
    })()`
  );

// ---------- 1. a person with no machine of their own ----------
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page
  .waitForFunction(`document.querySelectorAll('.chat-item').length === 2`, { timeout: 5000 })
  .catch(() => fail('the shared chats never showed up'));

if (!(await page.evaluate(`document.body.classList.contains('guest')`)))
  await fail('BUG: a guest with nothing open is not in guest mode');
ok('guest mode is on before anything has been clicked');

for (const sel of ['#permission-mode', '#model-select', '#effort-select', '#limits', '#share-btn', '#edit-btn'])
  if (await visible(sel)) await fail(`BUG: a guest is shown ${sel}`);
ok('no bypass switch, no model or effort, no limits, no 🔗, no ✎');

if (await visible('.add-host')) await fail('BUG: a guest is offered "add host"');
ok('no "add host" either');

// the whole project was shared: the host allows new chats in it and says so
if ((await plusOf(SHARED_PROJECT)) !== 'shown') await fail('BUG: no "+" in a project shared whole');
ok('a project shared whole offers "+ new chat"');
if ((await plusOf(CLOSED_PROJECT)) !== 'none') await fail('BUG: "+" offered where only one chat was shared');
ok('a project with one shared chat offers nothing');

await page.evaluate(
  `[...document.querySelectorAll('.project-name')].find((n) => n.title === ${JSON.stringify(SHARED_PROJECT)})
     .parentElement.querySelector('button[title="new chat"]').click()`
);
await wait(200);
const made = asked.filter((a) => a.type === 'create_chat').pop();
if (!made) await fail('the "+" sent nothing');
if (made.host !== 'host-them' || made.body.projectPath !== SHARED_PROJECT)
  await fail(`create_chat went to ${made.host} / ${made.body.projectPath}`);
if (made.body.permissionMode || made.body.model)
  await fail(`a guest asked for ${made.body.permissionMode ?? made.body.model} — that is the owner's to choose`);
ok('"+" asks that machine for a chat in that project, and asks for no privileges');

// and the chat they were invited into opens and shows its history
await page.evaluate(`document.querySelector('[data-chat-id="chat-shared"]').click()`);
await page
  .waitForFunction(`document.querySelectorAll('#feed .msg, #feed .message, #feed > *').length > 0`, { timeout: 4000 })
  .catch(() => fail('the shared chat opened empty'));
if (!asked.some((a) => a.type === 'history' && a.body.chatId === 'chat-shared'))
  await fail('opening the chat never asked for its history');
ok('a shared chat opens and its history is asked for and shown');

await checkSides('in a shared chat', {
  'от того, кто смотрит': 'right',
  'от владельца машины': 'left',
  'от другого гостя': 'left',
});

// Opening a chat is not an act of administration. Whatever the window asks the
// host on the way in has to be something a guest is allowed to ask — otherwise
// the refusal lands in their feed as a red banner about nothing they did.
await page.type('#input', 'печатаю');
await wait(800);
const refusals = asked.filter((a) => (a.host ?? 'host-them') === 'host-them' && !GUEST_TYPES.has(a.type));
if (refusals.length) await fail(`a guest's window asked for: ${[...new Set(refusals.map((r) => r.type))].join(', ')}`);
if (await visible('.error-banner')) await fail('a guest opening a chat is shown an error');
ok('opening a chat asks the host for nothing a guest may not ask');

// ---------- 2. an owner who also reads someone else's chats ----------
mode = 'mixed';
await page.reload({ waitUntil: 'networkidle2' });
await page
  .waitForFunction(`document.querySelectorAll('.chat-item').length === 3`, { timeout: 5000 })
  .catch(() => fail('the mixed sidebar never showed up'));

if (await page.evaluate(`document.body.classList.contains('guest')`))
  await fail('BUG: an owner with nothing open is treated as a guest');
if (!(await visible('#permission-mode'))) await fail('BUG: the owner lost the bypass switch');
ok('an owner keeps their controls with nothing open');

await page.evaluate(`document.querySelector('[data-chat-id="chat-shared"]').click()`);
await page
  .waitForFunction(`document.body.classList.contains('guest')`, { timeout: 3000 })
  .catch(() => fail("reading someone else's chat left the owner's controls up"));
ok("reading someone else's chat puts the window in guest mode");

// on that machine we are a guest like any other: nothing there is ours
await checkSides("in someone else's chat", {
  'от того, кто смотрит': 'right',
  'от владельца машины': 'left',
  'от другого гостя': 'left',
});

await page.evaluate(`document.querySelector('[data-chat-id="chat-mine"]').click()`);
await page
  .waitForFunction(`!document.body.classList.contains('guest')`, { timeout: 3000 })
  .catch(() => fail('coming back to their own chat did not restore the controls'));
ok('coming back to their own chat restores them');

// the same three messages on our own machine, where we are the owner: the
// sides turn over, because the identity did
await page.waitForFunction(`document.querySelectorAll('.msg-user').length === 3`, { timeout: 4000 }).catch(() => {});
await checkSides('in our own chat', {
  'от владельца машины': 'right',
  'от того, кто смотрит': 'left',
  'от другого гостя': 'left',
});

if (problems.length) await fail(problems.join('; '));
console.log('\nGUEST OK');
await browser.close();
server.close();
