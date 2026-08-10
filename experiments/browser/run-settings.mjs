// Settings belong to a computer, not to the app. With two hosts connected, the
// dialog has to say which one it is showing and send every change back to that
// one — saving into a stranger is the bug this exists for.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const PORT = 7780;

// two computers behind one socket, exactly as the relay presents them
const HOSTS = {
  'host-a': { name: 'NIDERE-PC', userName: 'Nidere', projectsRoot: 'C:\\Users\\Nidere\\Documents\\Projects' },
  'host-b': { name: 'LAPTOP', userName: 'Nid', projectsRoot: 'D:\\work' },
};

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

const asked = []; // { type, host }
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const say = (o) => ws.send(JSON.stringify(o));
  say({ type: 'hosts', hosts: Object.entries(HOSTS).map(([id, h]) => ({ id, name: h.name, own: true })) });
  for (const [id, h] of Object.entries(HOSTS)) {
    say({
      type: 'state',
      _host: id,
      projects: [{ path: h.projectsRoot, name: null, chats: [{ id: `chat-${id}`, sessionId: `s-${id}`, status: 'idle', title: `чат ${h.name}`, model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }] }],
    });
  }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    asked.push({ type: m.type, host: m._host ?? null, body: m });
    if (m.type === 'history') say({ type: 'history', chatId: m.chatId, messages: [] });
    if (m.type === 'get_settings') {
      const h = HOSTS[m._host] ?? HOSTS['host-a'];
      say({ type: 'settings', _host: m._host ?? 'host-a', userName: h.userName, projectsRoot: h.projectsRoot, relay: { paired: true, connected: true }, claudeAuth: { loggedIn: true, email: 'a@b.c', subscriptionType: 'max' } });
    }
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
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

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelectorAll('.chat-item').length === 2`, { timeout: 5000 }).catch(() => fail('both computers never showed up'));

await page.click('#settings-btn');
await page.waitForFunction(`!document.getElementById('settings').hidden`, { timeout: 3000 }).catch(() => fail('settings did not open'));
await wait(200);

// 1. the dialog says whose settings these are
const picker = await page.evaluate(`(() => {
  const label = document.getElementById('set-host-label');
  const select = document.getElementById('set-host');
  return { shown: !label.hidden, options: [...select.options].map((o) => o.textContent), value: select.value, root: document.getElementById('set-root').value };
})()`);
if (!picker.shown) await fail('with two computers connected the dialog does not say which one it is showing');
if (picker.options.length !== 2) await fail(`the picker lists ${picker.options.length} computers`);
ok(`the dialog names the computer (${picker.options.join(', ')})`);

// 2. what it shows is that computer's own settings
const firstHost = picker.value;
if (picker.root !== HOSTS[firstHost].projectsRoot) await fail(`showing ${picker.root} while ${firstHost} has ${HOSTS[firstHost].projectsRoot}`);
ok('it shows the settings of the computer it names');

// 3. switching asks the other computer about itself
const other = Object.keys(HOSTS).find((id) => id !== firstHost);
await page.select('#set-host', other);
await page.waitForFunction(`document.getElementById('set-root').value === ${JSON.stringify(HOSTS[other].projectsRoot)}`, { timeout: 3000 }).catch(() => fail('switching the computer did not load its settings'));
const askedOther = asked.some((a) => a.type === 'get_settings' && a.host === other);
if (!askedOther) await fail('the other computer was never asked about itself');
ok('switching computers loads that one, from that one');

// 4. and saving goes back to it — not to whichever host answers first
await page.evaluate(`document.getElementById('set-root').value = 'E:\\\\новое место'`);
await page.click('#settings-save');
await wait(300);
const saved = asked.filter((a) => a.type === 'set_settings');
if (!saved.length) await fail('nothing was saved at all');
const last = saved[saved.length - 1];
if (last.host !== other) await fail(`BUG: the settings of ${other} were sent to ${last.host ?? 'nobody in particular'}`);
if (last.body.projectsRoot !== 'E:\\новое место') await fail(`what was saved is not what was typed: ${last.body.projectsRoot}`);
ok('what you change is saved on the computer you were looking at');

// 5. restarting from here restarts that computer, too
await page.click('#settings-btn');
await wait(200);
await page.click('#restart-server');
await wait(200);
const restart = asked.filter((a) => a.type === 'restart_server').pop();
if (!restart || restart.host !== other) await fail(`restart went to ${restart?.host ?? 'nobody in particular'}`);
ok('and so does restarting it');

if (problems.length) await fail('page errors were collected');
console.log('SETTINGS OK');
await browser.close();
server.close();
