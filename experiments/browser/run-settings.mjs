// Settings belong to a computer, not to the app, and they are opened from that
// computer's row in the sidebar — the one place where a machine is already named.
// Saving into a stranger is the bug this exists for. The header's gear is a
// different thing entirely: the browser's own settings, which need no host at all.
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
      say({ type: 'settings', _host: m._host ?? 'host-a', userName: h.userName, projectsRoot: h.projectsRoot, relay: { paired: true, connected: true }, claudeAuth: { loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }, serverMode: { ready: true, reason: '' } });
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

// the row of a named computer, and the 🛠 on it
const openSettingsOf = (name) =>
  page.evaluate(
    `(() => {
      const head = [...document.querySelectorAll('.host-head')].find((h) => h.querySelector('.host-name')?.textContent === ${JSON.stringify(name)});
      if (!head) return 'no row for ' + ${JSON.stringify(name)};
      const btn = [...head.querySelectorAll('.host-actions button')].find((b) => b.title === 'settings of this computer');
      if (!btn) return 'no settings button on the row';
      btn.click();
      return '';
    })()`
  );

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.waitForFunction(`document.querySelectorAll('.chat-item').length === 2`, { timeout: 5000 }).catch(() => fail('both computers never showed up'));

// 1. a computer's settings are opened from the computer
const problem = await openSettingsOf(HOSTS['host-a'].name);
if (problem) await fail(problem);
await page.waitForFunction(`!document.getElementById('host-settings').hidden`, { timeout: 3000 }).catch(() => fail('the settings of that computer did not open'));
await wait(200);
ok('the 🛠 on a computer opens that computer');

// 2. the panel says whose settings these are, and shows theirs
const shown = await page.evaluate(`(() => ({
  title: document.getElementById('host-settings-title').textContent,
  root: document.getElementById('set-root').value,
}))()`);
if (shown.title !== HOSTS['host-a'].name) await fail(`the panel is titled "${shown.title}" and not "${HOSTS['host-a'].name}"`);
if (shown.root !== HOSTS['host-a'].projectsRoot) await fail(`showing ${shown.root} while host-a has ${HOSTS['host-a'].projectsRoot}`);
ok(`it names the computer (${shown.title}) and shows its own settings`);

// 3. the other computer's row asks the other computer
await page.click('#host-settings-cancel');
await wait(100);
await openSettingsOf(HOSTS['host-b'].name);
await page.waitForFunction(`document.getElementById('set-root').value === ${JSON.stringify(HOSTS['host-b'].projectsRoot)}`, { timeout: 3000 }).catch(() => fail('opening the other computer did not load its settings'));
if (!asked.some((a) => a.type === 'get_settings' && a.host === 'host-b')) await fail('the other computer was never asked about itself');
ok('the other row loads the other computer, from that one');

// 4. and saving goes back to it — not to whichever host answers first
await page.evaluate(`document.getElementById('set-root').value = 'E:\\\\новое место'`);
await page.click('#host-settings-save');
await wait(300);
const saved = asked.filter((a) => a.type === 'set_settings');
if (!saved.length) await fail('nothing was saved at all');
const last = saved[saved.length - 1];
if (last.host !== 'host-b') await fail(`BUG: the settings of host-b were sent to ${last.host ?? 'nobody in particular'}`);
if (last.body.projectsRoot !== 'E:\\новое место') await fail(`what was saved is not what was typed: ${last.body.projectsRoot}`);
ok('what you change is saved on the computer you were looking at');

// 5. restarting from there restarts that computer, too
await openSettingsOf(HOSTS['host-b'].name);
await wait(300);
await page.click('#restart-server');
await wait(200);
const restart = asked.filter((a) => a.type === 'restart_server').pop();
if (!restart || restart.host !== 'host-b') await fail(`restart went to ${restart?.host ?? 'nobody in particular'}`);
ok('and so does restarting it');

// 6. the header's gear is the browser's own, and asks no computer anything
const before = asked.length;
await page.click('#settings-btn');
await page.waitForFunction(`!document.getElementById('settings').hidden`, { timeout: 3000 }).catch(() => fail('the device settings did not open'));
const nothingHostly = await page.evaluate(`document.getElementById('host-settings').hidden && !!document.getElementById('wake-label')`);
if (!nothingHostly) await fail('the header gear opened a computer, not the browser');
if (asked.length !== before) await fail(`opening the browser's own settings asked a computer: ${asked.slice(before).map((a) => a.type).join(', ')}`);
ok('the header gear is this browser, and needs no computer to open');

if (problems.length) await fail('page errors were collected');
console.log('SETTINGS OK');
await browser.close();
server.close();
