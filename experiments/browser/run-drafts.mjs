// Never lose a long message. The app against a fake host: what is typed reaches
// the host, comes back after a reload, arrives from another device, and a send
// that the socket swallowed puts the text back in the box instead of nowhere.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const CHAT = 'chat-1';
const PORT = 7782;
const LONG = 'Очень длинное сообщение. '.repeat(60);

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

let stored = null; // the host's copy of the draft
let sockets = [];
let sends = [];
let swallowSends = false;
const uploads = []; // files handed over from the browser

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.push(ws);
  const say = (o) => ws.send(JSON.stringify(o));
  say({
    type: 'state',
    projects: [{ path: 'C:\\fake\\proj', name: null, chats: [{ id: CHAT, sessionId: 's1', status: 'idle', title: 'чат', model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }] }],
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'history') {
      say({ type: 'history', chatId: CHAT, messages: [] });
      if (stored) say({ type: 'draft', chatId: CHAT, ...stored });
    }
    if (m.type === 'save_draft') {
      stored = m.text.trim() ? { text: m.text, at: m.at } : null;
    }
    if (m.type === 'upload_file') {
      uploads.push(m);
      if (m.last !== false)
      say({ type: 'file_uploaded', chatId: CHAT, name: m.name, path: ['C:', 'fake', 'proj', '.remaude', 'uploads', m.name].join('\\'), size: 12 });
    }
    if (m.type === 'send') {
      sends.push(m);
      if (swallowSends) return; // no echo, as if the host never heard it
      say({
        type: 'chat_message',
        chatId: CHAT,
        msg: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: m.content }, localId: m.localId, author: 'Nidere' },
      });
    }
  });
  ws.on('close', () => (sockets = sockets.filter((s) => s !== ws)));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
let wsLog = [];
page.on('console', (m) => {
  if (m.text().startsWith('WSIN')) wsLog.push(m.text().slice(5));
  if (m.text().startsWith('DBG')) console.log('  page:', m.text());
});
await page.evaluateOnNewDocument(() => {
  const Original = WebSocket;
  window.WebSocket = function (...args) {
    const socket = new Original(...args);
    socket.addEventListener('message', (e) => {
      try {
        console.log('WSIN ' + JSON.parse(e.data).type);
      } catch {}
    });
    return socket;
  };
  window.WebSocket.prototype = Original.prototype;
  window.WebSocket.OPEN = Original.OPEN;
});
const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (n) => console.log('ok:', n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const openChat = async () => {
  await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('no sidebar'));
  await page.evaluate(`document.querySelector('.chat-item').click()`);
  await wait(300);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await openChat();

// 1. what is typed reaches the host by itself
await page.type('#input', LONG.slice(0, 200));
await page.waitForFunction(() => true, {});
await wait(1400); // the debounce
if (!stored || !stored.text.includes('Очень длинное')) await fail('the draft never reached the host');
ok('typing reaches the host without asking');

// 2. a reload brings it back
await page.reload({ waitUntil: 'networkidle2' });
await openChat();
const afterReload = await page.evaluate(`document.getElementById('input').value`);
if (!afterReload.includes('Очень длинное')) await fail(`a reload lost the draft: "${afterReload.slice(0, 40)}"`);
ok('a reload brings the draft back');

// 3. it also survives the browser forgetting everything it knew (a cleared cache,
//    a new device — the host's copy is all there is)
await page.evaluate(`localStorage.clear()`);
await page.reload({ waitUntil: 'networkidle2' });
await openChat();
const fromHost = await page.evaluate(`document.getElementById('input').value`);
if (!fromHost.includes('Очень длинное')) await fail(`without local storage the draft was lost: "${fromHost.slice(0, 40)}"`);
// opening a chat must not be mistaken for typing an empty message
if (!stored?.text?.includes('Очень длинное')) await fail('opening the chat wiped the draft on the host');
ok('the host alone can bring it back — cleared cache, another device');

// 4. a draft from elsewhere lands in an idle composer
await page.evaluate(`document.getElementById('input').value = ''`);
stored = { text: 'написано с телефона', at: Date.now() + 5000 };
for (const s of sockets) s.send(JSON.stringify({ type: 'draft', chatId: CHAT, ...stored }));
await page.waitForFunction(`document.getElementById('input').value === 'написано с телефона'`, { timeout: 3000 }).catch(() => fail('a draft from another device never arrived'));
ok('a draft written elsewhere appears here');

// 5. …but never on top of something newer being typed right now
await page.click('#input');
await page.keyboard.down('Control');
await page.keyboard.press('KeyA');
await page.keyboard.up('Control');
await page.type('#input', 'я печатаю прямо сейчас');
await wait(50);
for (const s of sockets) s.send(JSON.stringify({ type: 'draft', chatId: CHAT, text: 'старое с телефона', at: Date.now() - 60_000 }));
await wait(200);
const kept = await page.evaluate(`document.getElementById('input').value`);
if (kept !== 'я печатаю прямо сейчас') await fail(`an older copy overwrote live typing: "${kept}"`);
ok('an older copy never overwrites what is being typed');

// 6. a send the host never confirmed puts the text back
swallowSends = true;
const before = sends.length;
await page.click('#send-btn');
await page.waitForFunction(`${before} < ${sends.length + 1} && document.getElementById('input').value === ''`, { timeout: 3000 }).catch(() => {});
await wait(200);
if (sends.length === before) await fail('the message was never sent at all');
for (const s of sockets) s.close(); // the socket dies before any echo
await page.waitForFunction(`document.getElementById('input').value.includes('я печатаю прямо сейчас')`, { timeout: 5000 }).catch(() => fail('BUG: a message lost to a dead socket did not come back to the box'));
ok('a message the host never confirmed comes back to the box');

// ---------- attaching a file that is not a picture ----------
// the socket was killed above on purpose; let the app find its way back first
await page.waitForFunction(`document.getElementById('conn-dot').classList.contains('on')`, { timeout: 10000 }).catch(() => fail('the app never reconnected'));
const arrived = async (n) => {
  for (let i = 0; i < 60 && uploads.length < n; i++) await wait(100);
  if (uploads.length < n) await fail(`only ${uploads.length} of ${n} pieces reached the host`);
};
await page.evaluate(`document.getElementById('input').value = ''`);
await page.evaluate(`(() => {
  const data = new DataTransfer();
  data.items.add(new File(['столбец;значение\\n1;2\\n'], 'таблица.csv', { type: 'text/csv' }));
  const input = document.getElementById('file-input');
  input.files = data.files;
  input.dispatchEvent(new Event('change'));
})()`);
await page.waitForFunction(`document.querySelector('#attachments .att-file') !== null`, { timeout: 3000 }).catch(() => fail('an attached file never appeared in the composer'));
await arrived(1);
const upload = uploads[uploads.length - 1];
if (!upload) await fail('the file never reached the host');
if (upload.name !== 'таблица.csv') await fail(`the file arrived under another name: ${upload.name}`);
if (Buffer.from(upload.data, 'base64').toString('utf-8') !== 'столбец;значение\n1;2\n') await fail('the file arrived damaged');
ok('a file goes to the host as it is');

// a big one is handed over in pieces, in order, none of them oversized
const bigUploads = uploads.length;
await page.evaluate(`(() => {
  const data = new DataTransfer();
  data.items.add(new File([new Uint8Array(9 * 1024 * 1024)], 'большой.bin', { type: 'application/octet-stream' }));
  const input = document.getElementById('file-input');
  input.files = data.files;
  input.dispatchEvent(new Event('change'));
})()`);
await page.waitForFunction(`[...document.querySelectorAll('#attachments .att-file')].some((n) => n.textContent.includes('большой.bin'))`, { timeout: 10000 }).catch(() => fail('a big file never showed up in the composer'));
await wait(1500);
const pieces = uploads.slice(bigUploads);
if (pieces.length < 3) await fail(`a 9 MB file went over in ${pieces.length} piece(s) — it should be split`);
if (!pieces[0].last === false && pieces.length > 1) await fail('the first piece was marked as the last');
if (!pieces[pieces.length - 1].last) await fail('no piece was marked as the last one');
if (pieces.some((p) => Buffer.from(p.data, 'base64').length > 8 * 1024 * 1024)) await fail('a piece is too big for a frame');
if (pieces.some((p, i) => p.seq !== i)) await fail(`the pieces arrived out of order: ${pieces.map((p) => p.seq).join(',')}`);
const total = pieces.reduce((n, p) => n + Buffer.from(p.data, 'base64').length, 0);
if (total !== 9 * 1024 * 1024) await fail(`the pieces do not add up: ${total} of ${9 * 1024 * 1024}`);
ok(`a big file goes over in pieces (${pieces.length}, in order, adding up)`);

await page.type('#input', 'посмотри таблицу');
await page.click('#send-btn');
await wait(300);
const sent = sends[sends.length - 1];
const said = typeof sent.content === 'string' ? sent.content : sent.content.find((b) => b.type === 'text')?.text ?? '';
if (!said.includes('посмотри таблицу')) await fail('the message lost its words');
// both files are still attached, and the message names both
for (const name of ['таблица.csv', 'большой.bin']) {
  const expectedPath = ['C:', 'fake', 'proj', '.remaude', 'uploads', name].join('\\');
  if (!said.includes(expectedPath)) await fail(`the message does not say where ${name} is: ${said}`);
}
if (await page.evaluate(`document.querySelector('#attachments .att-file') !== null`)) await fail('the attachment stayed in the composer after sending');
ok('the message tells the session where the file is');

if (problems.length) await fail('page errors were collected');
console.log('DRAFTS OK');
await browser.close();
server.close();
