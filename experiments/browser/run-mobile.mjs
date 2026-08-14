// Mobile repro: the real web app against a fake host speaking the WS protocol.
// Question under test: does the stop button show while the chat is thinking?
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const CHAT = 'chat-1';
const PROJ = 'C:\\fake\\proj';

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const data = await readFile(join(WEB, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(data);
  } catch {
    res.writeHead(404).end('nope');
  }
});

let hostSocket = null;
const wss = new WebSocketServer({ server, path: '/ws' });
const state = (status) => ({
  type: 'state',
  projects: [
    {
      path: PROJ,
      name: null,
      chats: [{ id: CHAT, sessionId: 'a4b2c1d0-1111-2222-3333-444455556666', status, title: 'тестовый чат', model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }],
    },
  ],
});
wss.on('connection', (ws) => {
  hostSocket = ws;
  ws.send(JSON.stringify(state('thinking')));
  ws.send(JSON.stringify({ type: 'comments_badge', total: 0, perDoc: {} }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'history') ws.send(JSON.stringify({ type: 'history', chatId: msg.chatId, messages: [] }));
  });
});
await new Promise((r) => server.listen(7787, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
// a stubbed Wake Lock API: counts requests/releases and lets us fake iOS
// revoking the lock whenever the app goes to the background
await page.evaluateOnNewDocument(() => {
  window.__wake = { requests: 0, releases: 0 };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        window.__wake.requests++;
        return { addEventListener() {}, release: async () => void window.__wake.releases++ };
      },
    },
  });
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
  window.__setVisible = (v) => {
    vis = v ? 'visible' : 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  };
});

const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('dialog', async (d) => {
  problems.push(`DIALOG: ${d.message()}`);
  await d.dismiss();
});

const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await browser.close();
  server.close();
  process.exit(1);
};
const ok = (name) => console.log('ok:', name);

await page.goto('http://127.0.0.1:7787/', { waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('sidebar never rendered'));

// select the chat (the app may have auto-selected it; click to be sure)
await page.evaluate(`document.querySelector('.chat-item').click()`);
await new Promise((r) => setTimeout(r, 300));

const visible = (sel) => `(() => { const n = document.querySelector('${sel}'); return n && n.offsetParent !== null && getComputedStyle(n).display !== 'none'; })()`;

const stopWhileThinking = await page.evaluate(visible('#stop-btn'));
const diag = await page.evaluate(`(() => {
  const n = document.getElementById('stop-btn');
  const r = n.getBoundingClientRect();
  return { hidden: n.hidden, display: getComputedStyle(n).display, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, guest: document.body.className, inViewport: r.y < innerHeight && r.x < innerWidth && r.width > 0 };
})()`);
console.log('stop-btn diag:', JSON.stringify(diag));
if (!stopWhileThinking || !diag.inViewport) await fail('BUG REPRODUCED: stop button not visible on mobile while thinking');
ok('stop button visible while thinking (mobile viewport)');

// status back to idle -> stop hides
hostSocket.send(JSON.stringify({ type: 'chat_status', chatId: CHAT, status: 'idle' }));
await page.waitForFunction(`document.getElementById('stop-btn').hidden === true`, { timeout: 2000 }).catch(() => fail('stop did not hide on idle'));
ok('stop hides on idle');

// and shows again on thinking
hostSocket.send(JSON.stringify({ type: 'chat_status', chatId: CHAT, status: 'thinking' }));
await page.waitForFunction(visible('#stop-btn'), { timeout: 2000 }).catch(() => fail('BUG REPRODUCED: stop did not appear on thinking status'));
ok('stop appears on thinking status');

// ---------- keep the screen awake ----------
if (await page.evaluate(`window.__wake.requests !== 0`)) await fail('a lock was taken while the switch was off');
ok('no wake lock until asked');

await page.evaluate(`document.getElementById('settings').hidden = false`);
const switchVisible = await page.evaluate(visible('#wake-label'));
if (!switchVisible) await fail('BUG: the wake-lock switch is not visible in settings');
ok('switch visible in settings');

await page.evaluate(`document.getElementById('wake-lock').click()`);
await new Promise((r) => setTimeout(r, 50));
const afterOn = await page.evaluate(`({ stored: localStorage.getItem('wakeLock'), ...window.__wake })`);
if (afterOn.stored !== '1' || afterOn.requests !== 1) await fail(`switching on did not take a lock: ${JSON.stringify(afterOn)}`);
ok('switching on takes a lock and remembers the choice');

// the app goes to the background and comes back — the lock must be re-taken
await page.evaluate(`window.__setVisible(false)`);
await new Promise((r) => setTimeout(r, 50));
await page.evaluate(`window.__setVisible(true)`);
await new Promise((r) => setTimeout(r, 50));
const afterReturn = await page.evaluate(`window.__wake`);
if (afterReturn.requests !== 2) await fail(`BUG: the lock was not re-taken after a return (${JSON.stringify(afterReturn)})`);
ok('lock is re-taken after backgrounding');

// switching off releases it and stops re-taking
await page.evaluate(`document.getElementById('wake-lock').click()`);
await new Promise((r) => setTimeout(r, 50));
await page.evaluate(`window.__setVisible(false); window.__setVisible(true)`);
await new Promise((r) => setTimeout(r, 50));
const afterOff = await page.evaluate(`({ stored: localStorage.getItem('wakeLock'), ...window.__wake })`);
// two releases by now: one when the app went to the background, one just now
if (afterOff.stored !== '0' || afterOff.releases !== 2 || afterOff.requests !== 2)
  await fail(`switching off misbehaved: ${JSON.stringify(afterOff)}`);
ok('switching off releases the lock and stays off');

// the choice survives a reload
await page.evaluate(`localStorage.setItem('wakeLock', '1')`);
await page.reload({ waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 200));
const afterReload = await page.evaluate(`({ checked: document.getElementById('wake-lock').checked, ...window.__wake })`);
if (!afterReload.checked || afterReload.requests !== 1) await fail(`the choice did not survive a reload: ${JSON.stringify(afterReload)}`);
ok('choice survives a restart of the app');

// ---------- markup while the answer is still being typed ----------
const delta = (text) =>
  hostSocket.send(
    JSON.stringify({
      type: 'chat_message',
      chatId: CHAT,
      msg: {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      },
    })
  );

for (const piece of ['**Главное:** тело ', 'дока должно ', 'оставаться правдой, см. `effects.md`', '\n\n- первый пункт\n- второй']) {
  delta(piece);
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 300));
const midStream = await page.evaluate(`(() => {
  const n = document.querySelector('#feed .msg-assistant.streaming');
  if (!n) return { ok: false, why: 'nothing is being typed on screen' };
  return { ok: true, bold: Boolean(n.querySelector('b')), code: Boolean(n.querySelector('code')), list: Boolean(n.querySelector('li')), raw: n.textContent.includes('**') };
})()`);
if (!midStream.ok) await fail(midStream.why);
if (!midStream.bold || !midStream.code || !midStream.list)
  await fail(`markup is not rendered while typing: ${JSON.stringify(midStream)}`);
if (midStream.raw) await fail('raw ** is still showing in a half-typed answer');
ok('markup renders while the answer is still being typed');

// the feed stays at the newest line while an answer is written
const grow = async (from, to) => {
  for (let i = from; i < to; i++) {
    delta(`\n\nабзац номер ${i}, достаточно длинный, чтобы лента переросла экран и её пришлось бы прокручивать`);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 400));
};
const feedState = () =>
  page.evaluate(`(() => {
    const feed = document.getElementById('feed');
    const node = document.querySelector('#feed .msg-assistant.streaming');
    return {
      fromBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight,
      tall: node.getBoundingClientRect().height > feed.clientHeight,
      downButton: !document.getElementById('scroll-down').hidden,
    };
  })()`);

await grow(0, 40);
let view = await feedState();
if (!view.tall) await fail('the test did not manage to outgrow the screen');
if (view.fromBottom > 4) await fail(`the feed fell behind the answer by ${Math.round(view.fromBottom)}px`);
ok('the feed keeps up with an answer as it is written');

// scrolling away stops it: nothing moves under the reader
await page.evaluate(`document.getElementById('feed').scrollTop -= 600`);
await new Promise((r) => setTimeout(r, 100));
const before = (await feedState()).fromBottom;
await grow(40, 60);
view = await feedState();
if (view.fromBottom <= before) await fail('the feed dragged the view back down after a scroll away');
if (!view.downButton) await fail('nothing offers a way back to the newest line');
ok('scrolling away stops it following');

// coming back to the bottom picks it up again
await page.evaluate(`const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight`);
await new Promise((r) => setTimeout(r, 100));
await grow(60, 70);
view = await feedState();
if (view.fromBottom > 4) await fail(`coming back did not resume following: ${Math.round(view.fromBottom)}px behind`);
ok('coming back to the bottom follows again');

// and the finished message replaces the stream cleanly, without doubling it
hostSocket.send(
  JSON.stringify({
    type: 'chat_message',
    chatId: CHAT,
    msg: {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'u-final',
      message: { role: 'assistant', content: [{ type: 'text', text: '**Главное:** тело дока должно оставаться правдой, см. `effects.md`\n\n- первый пункт\n- второй' }] },
    },
  })
);
await page.waitForFunction(`document.querySelectorAll('#feed .msg-assistant.streaming').length === 0`, { timeout: 3000 }).catch(() => fail('the streaming bubble outlived the answer'));
const finals = await page.evaluate(`[...document.querySelectorAll('#feed .msg-assistant')].filter((n) => n.textContent.includes('Главное')).length`);
if (finals !== 1) await fail(`the answer ended up on screen ${finals} times`);
ok('the finished answer replaces the stream, once');

// ---------- nothing pushes the conversation off the screen ----------
// one wide thing in one message used to widen the whole column, and every other
// message got clipped by the window edge
hostSocket.send(
  JSON.stringify({
    type: 'chat_message',
    chatId: CHAT,
    msg: {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'u-wide',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text:
              '```\n' +
              'const оченьДлиннаяСтрокаКода = "' + 'x'.repeat(400) + '";\n' +
              '```\n\n' +
              'Обычный абзац, который обязан переноситься по ширине экрана, а не уезжать за его край вместе со всем остальным.\n\n' +
              'путь/который/никак/не/переносится/' + 'ы'.repeat(200),
          },
        ],
      },
    },
  })
);
await new Promise((r) => setTimeout(r, 400));
const spill = await page.evaluate(`(() => {
  const feed = document.getElementById('feed');
  const prose = [...feed.querySelectorAll('.msg-assistant div')].find((d) => d.textContent.includes('Обычный абзац'));
  return {
    feedSpill: feed.scrollWidth - feed.clientWidth,
    proseWidth: prose ? prose.getBoundingClientRect().width : 0,
    view: feed.clientWidth,
  };
})()`);
if (spill.feedSpill > 2) await fail(`the conversation runs off the screen by ${spill.feedSpill}px`);
if (spill.proseWidth > spill.view) await fail(`a paragraph is wider than the screen: ${Math.round(spill.proseWidth)} of ${spill.view}`);
ok('a wide code block scrolls inside itself and leaves the text alone');

// the header must show what the chat runs as, from the state snapshot alone —
// a reopened session says nothing about itself until it is spoken to, and a
// reload has nothing but the snapshot
const header = await page.evaluate(`({ model: document.getElementById('model-select').value, effort: document.getElementById('effort-select').value })`);
if (header.model !== 'opus' || header.effort !== 'high')
  await fail(`the header dropdowns did not take the snapshot's values: ${JSON.stringify(header)}`);
ok('model and effort come from the state snapshot');

await page.reload({ waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelector('.chat-item') !== null`, { timeout: 5000 }).catch(() => fail('no sidebar after reload'));
await new Promise((r) => setTimeout(r, 400));
const headerAfterReload = await page.evaluate(`({ model: document.getElementById('model-select').value, effort: document.getElementById('effort-select').value })`);
if (headerAfterReload.model !== 'opus' || headerAfterReload.effort !== 'high')
  await fail(`after a reload the header forgot what the chat runs as: ${JSON.stringify(headerAfterReload)}`);
ok('and survive a page reload');

if (problems.length) await fail('page errors were collected');
console.log('MOBILE REPRO ALL OK');
await browser.close();
server.close();
