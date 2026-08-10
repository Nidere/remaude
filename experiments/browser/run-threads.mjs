// Threads in a chat, driven through the real app: a reply hangs off a message,
// the answer lands in the thread and never in the feed, and a reload keeps it
// that way. Run with "mobile" as the first argument for the phone layout.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const MOBILE = process.argv[2] === 'mobile';
const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const CHAT = 'chat-1';
const ANCHOR = 'uuid-answer-1';
const PORT = MOBILE ? 7784 : 7785;

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

const say = (ws, o) => ws.send(JSON.stringify(o));
const answer = (uuid, text, extra = {}) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  timestamp: new Date().toISOString(),
  ...extra,
});

let threadId = null;
const threadMsgs = []; // what the host would have tagged
const sent = []; // everything the client asked to send

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  say(ws, {
    type: 'state',
    projects: [
      {
        path: 'C:\\fake\\proj',
        name: null,
        chats: [{ id: CHAT, sessionId: 'sess-1', status: 'idle', title: 'чат', model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }],
      },
    ],
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'history') {
      say(ws, { type: 'history', chatId: CHAT, messages: [answer(ANCHOR, 'первый ответ модели'), ...threadMsgs] });
      say(ws, { type: 'chat_threads', chatId: CHAT, threads: threadId ? [{ id: threadId, anchorUuid: ANCHOR, createdAt: 1 }] : [] });
    }
    if (m.type === 'create_thread') {
      threadId = threadId ?? 'thread-1';
      say(ws, { type: 'chat_threads', chatId: CHAT, threads: [{ id: threadId, anchorUuid: m.anchorUuid, createdAt: 1 }] });
      say(ws, { type: 'thread_opened', chatId: CHAT, threadId });
    }
    if (m.type === 'send') {
      sent.push(m);
      const mark = `[remaude: thread ${m.threadId} — a side thread of this chat.]`;
      const userMsg = {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: m.threadId ? `${mark}\n${m.content}` : m.content },
        timestamp: new Date().toISOString(),
        author: 'Nidere',
        localId: m.localId,
        ...(m.threadId ? { chatThread: m.threadId } : {}),
      };
      say(ws, { type: 'chat_message', chatId: CHAT, msg: userMsg });
      if (m.threadId) threadMsgs.push(userMsg);
      // the model types first — these deltas used to paint a bubble in the feed
      // that nothing ever cleared
      for (const piece of ['ответ ', 'в ', 'ветке']) {
        say(ws, {
          type: 'chat_message',
          chatId: CHAT,
          msg: {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } },
            ...(m.threadId ? { chatThread: m.threadId } : {}),
          },
        });
      }
      setTimeout(() => {
        const reply = answer('uuid-reply-' + Math.random(), 'ответ в ветке', m.threadId ? { chatThread: m.threadId } : {});
        say(ws, { type: 'chat_message', chatId: CHAT, msg: reply });
        if (m.threadId) threadMsgs.push(reply);
        say(ws, {
          type: 'chat_message',
          chatId: CHAT,
          msg: { type: 'result', duration_ms: 900, ...(m.threadId ? { chatThread: m.threadId } : {}) },
        });
      }, 120);
    }
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
const W = MOBILE ? 390 : 1280;
const H = MOBILE ? 844 : 800;
await page.setViewport({ width: W, height: H, isMobile: MOBILE, hasTouch: MOBILE, deviceScaleFactor: MOBILE ? 3 : 1 });

const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) problems.push('console: ' + m.text());
});
const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (n) => console.log(`ok${MOBILE ? ' (mobile)' : ''}:`, n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('no sidebar'));
await page.evaluate(`document.querySelector('.chat-item').click()`);
await page.waitForFunction(`document.querySelector('.msg-assistant[data-uuid]') !== null`, { timeout: 5000 }).catch(() => fail('the answer never rendered'));

// 1. every answer offers a thread
const replyBtn = '.msg-assistant[data-uuid] .reply-btn';
if (!(await page.evaluate(`document.querySelector('${replyBtn}') !== null`))) await fail('no ↩ on the answer');
if (MOBILE && Number(await page.evaluate(`getComputedStyle(document.querySelector('${replyBtn}')).opacity`)) < 1)
  await fail('on a phone ↩ must be visible without hovering');
ok('answers carry a ↩');

// 2. it opens a thread panel
await page.evaluate(`document.querySelector('${replyBtn}').click()`);
await page.waitForFunction(`!document.getElementById('thread-panel').hidden`, { timeout: 3000 }).catch(() => fail('the thread panel did not open'));
const anchorShown = await page.evaluate(`document.querySelector('.thread-anchor-text').textContent`);
if (!anchorShown.includes('первый ответ')) await fail(`the panel does not show what it hangs off: ${anchorShown}`);
const panel = await page.evaluate(`(() => { const r = document.getElementById('thread-panel').getBoundingClientRect(); return { right: r.right, bottom: r.bottom, w: r.width }; })()`);
if (MOBILE) {
  if (Math.abs(panel.bottom - H) > 1 || Math.abs(panel.w - W) > 1) await fail(`on a phone the thread must be a bottom sheet: ${JSON.stringify(panel)}`);
} else if (Math.abs(panel.right - W) > 1 || panel.w > 420) {
  await fail(`on a desktop the thread must be a right-hand panel: ${JSON.stringify(panel)}`);
}
ok('thread panel opens where it should');

// 3. a reply written in the thread goes to the host with its thread id
await page.type('#thread-input', 'уточнение по этому ответу');
await page.evaluate(`document.getElementById('thread-send').click()`);
await page.waitForFunction(`document.querySelectorAll('#thread-body .thread-msg').length >= 2`, { timeout: 4000 }).catch(() => fail('the exchange did not appear in the thread'));
const lastSend = sent[sent.length - 1];
if (!lastSend?.threadId) await fail('the message left without a thread id');
if (String(lastSend.content).includes('[remaude:')) await fail('the client must not compose the service marker itself');
ok('a thread reply carries its thread id to the host');

// 4. the answer lands in the thread and nowhere else — the half-typed bubble included
const leaked = await page.evaluate(`({
  feed: [...document.querySelectorAll('#feed .msg-assistant')].some((n) => n.textContent.includes('ответ в ветке')),
  streaming: document.querySelectorAll('#feed .streaming').length,
  panel: document.getElementById('thread-body').textContent.includes('ответ в ветке'),
  marker: document.getElementById('thread-body').textContent.includes('[remaude:'),
})`);
if (leaked.feed) await fail('BUG: the thread answer leaked into the main feed');
if (leaked.streaming) await fail('BUG: a half-typed bubble of the thread answer was left in the feed');
if (!leaked.panel) await fail('the answer never reached the thread');
if (leaked.marker) await fail('the service marker is showing in the thread');
ok('the answer stays in the thread, out of the feed');

// 5. the anchor grows a chip
await page.waitForFunction(`document.querySelector('.msg-assistant[data-uuid] .thread-chip') !== null`, { timeout: 3000 }).catch(() => fail('no 💬 chip on the anchor message'));
const chip = await page.evaluate(`document.querySelector('.thread-chip').textContent`);
if (!/💬 \d/.test(chip)) await fail(`the chip should count the replies, got "${chip}"`);
ok(`the anchor shows the thread ("${chip}")`);

// 6. a reload rebuilds the same picture from history
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('no sidebar after reload'));
await page.evaluate(`document.querySelector('.chat-item').click()`);
await wait(600);
const afterReload = await page.evaluate(`({
  feedLeak: [...document.querySelectorAll('#feed .msg')].some((n) => n.textContent.includes('ответ в ветке') || n.textContent.includes('уточнение по этому')),
  chip: document.querySelector('.thread-chip')?.textContent ?? null,
})`);
if (afterReload.feedLeak) await fail('BUG: after a reload the thread messages fell back into the feed');
if (!afterReload.chip) await fail('after a reload the anchor lost its thread chip');
ok('a reload keeps threads where they belong');

// 7. the chip reopens the thread with everything in it
await page.evaluate(`document.querySelector('.thread-chip').click()`);
await page.waitForFunction(`!document.getElementById('thread-panel').hidden`, { timeout: 3000 }).catch(() => fail('the chip did not reopen the thread'));
const reopened = await page.evaluate(`document.getElementById('thread-body').textContent`);
if (!reopened.includes('ответ в ветке') || !reopened.includes('уточнение по этому')) await fail('the reopened thread lost its messages');
ok('the chip reopens the thread with everything in it');

if (problems.length) await fail('errors were collected along the way');
console.log(MOBILE ? 'THREADS MOBILE OK' : 'THREADS OK');
await browser.close();
server.close();
