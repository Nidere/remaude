// Project extensions in the real app, against a fake host that serves them with
// the real extensions.js: the 🧩 button appears for a project that has one, the
// command is asked about before it ever runs, the page gets its data through
// remaude.run(), can open a project file, and cannot reach cookies, the app's
// page or the network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../../node_modules/ws/wrapper.mjs';
import puppeteer from '../../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { listExtensions, manifestOf, buildPage, runCommand, projectFile } from '../../src/host/extensions.js';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/json' };
const CHAT = 'chat-1';
const PORT = 7783;

const project = mkdtempSync(join(tmpdir(), 'remaude-ext-ui-'));
const dir = join(project, '.remaude-ext', 'ci');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'CI', icon: '🔧', command: [process.execPath, 'status.js'] }));
writeFileSync(join(project, 'status.js'), 'console.log(JSON.stringify({ done: 237, of: 530 }))');
writeFileSync(
  join(dir, 'index.html'),
  `<!doctype html><body><div id="out">waiting</div><div id="probe"></div><a id="log" href="#">log</a>
<script src="app.js"></script></body>`
);
writeFileSync(
  join(dir, 'app.js'),
  `const probe = [];
try { document.cookie; probe.push('cookie:read'); } catch { probe.push('cookie:blocked'); }
try { parent.document.title; probe.push('parent:read'); } catch { probe.push('parent:blocked'); }
fetch('http://127.0.0.1:${PORT}/index.html').then(() => probe.push('net:open'), () => probe.push('net:blocked'))
  .finally(() => (document.getElementById('probe').textContent = probe.join(' ')));
remaude.run().then((d) => (document.getElementById('out').textContent = d.ok ? d.json.done + '/' + d.json.of : 'error ' + d.error));
document.getElementById('log').onclick = () => remaude.open('logs/a.log');`
);

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' }).end(await readFile(join(WEB, path)));
  } catch {
    res.writeHead(404).end('nope');
  }
});

let approved = null;
const seen = [];
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const say = (o) => ws.send(JSON.stringify(o));
  say({
    type: 'state',
    projects: [{ path: project, name: null, chats: [{ id: CHAT, sessionId: 's1', status: 'idle', title: 'чат', model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }] }],
  });
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    seen.push(m);
    if (m.type === 'history') say({ type: 'history', chatId: CHAT, messages: [] });
    if (m.type === 'ext_list') say({ type: 'ext_list', chatId: CHAT, exts: listExtensions(project) });
    if (m.type === 'ext_approve') approved = m.hash;
    if (m.type === 'ext_open' || m.type === 'ext_approve') {
      const man = manifestOf(project, m.id);
      if (approved !== man.hash) say({ type: 'ext_page', chatId: CHAT, id: m.id, name: man.name, ask: { command: man.command, hash: man.hash } });
      else say({ type: 'ext_page', chatId: CHAT, id: m.id, name: man.name, page: buildPage(project, m.id).page });
    }
    if (m.type === 'ext_run') say({ type: 'ext_data', chatId: CHAT, id: m.id, reqId: m.reqId, ...(await runCommand(project, m.id)) });
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
const done = async (code) => {
  await browser.close();
  server.close();
  rmSync(project, { recursive: true, force: true });
  process.exit(code);
};
const fail = async (why) => {
  console.error('FAIL:', why);
  for (const p of problems) console.error(' ', p);
  await done(1);
};
const ok = (n) => console.log('ok:', n);
const frameText = async (sel) => {
  const f = page.frames().find((fr) => fr !== page.mainFrame());
  return f ? f.$eval(sel, (n) => n.textContent).catch(() => null) : null;
};
const until = async (fn, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  await fail(what);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.waitForSelector('.chat-item', { timeout: 5000 }).catch(() => fail('no sidebar'));
await page.evaluate(`document.querySelector('.chat-item').click()`);
await until(() => page.evaluate(`!document.getElementById('ext-btn').hidden`), 'the 🧩 button never appeared');
ok('a project with an extension shows the button');

await page.click('#ext-btn');
await until(() => page.evaluate(`!!document.querySelector('.ext-ask button')`), 'no question before the command');
if (seen.some((m) => m.type === 'ext_run')) await fail('the command ran before it was allowed');
ok('the command is asked about first, and has not run');

await page.click('.ext-ask button');
await until(async () => (await frameText('#out')) === '237/530', 'the page never got its data');
ok('allowed: the page asked remaude.run() and got the JSON');

await until(async () => ((await frameText('#probe')) ?? '').split(' ').length === 3, 'the probe never finished');
const probe = await frameText('#probe');
if (probe !== 'cookie:blocked parent:blocked net:blocked') await fail(`the frame reached out: ${probe}`);
ok('no cookies, no parent page, no network from inside the frame');

const f = page.frames().find((fr) => fr !== page.mainFrame());
await f.click('#log');
await until(() => seen.some((m) => m.type === 'ext_file' && m.path === 'logs/a.log'), 'remaude.open() never reached the host');
if (projectFile(project, 'logs/a.log') !== join(project, 'logs', 'a.log')) await fail('the host would not resolve it');
ok('remaude.open() asks the host for a project file');
if ((await frameText('#out')) !== '237/530') await fail('a link click navigated the page away');
ok('a link click does not navigate the frame away');

await page.click('#ext-close');
await until(() => page.evaluate(`!document.querySelector('#ext-body iframe')`), 'closing left the page running');
ok('closing the panel drops the page');

// the chat that was open comes back by itself on load, painted from the cached
// transcript before the host says anything, and never clicked
await page.evaluate(() => {
  localStorage.setItem('lastChat', 'chat-1');
  localStorage.setItem('lastSession', 's1');
  const msg = { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
  localStorage.setItem('transcript', JSON.stringify({ key: 's1', msgs: [msg] }));
});
await page.reload({ waitUntil: 'networkidle2' });
await until(() => page.evaluate(`!document.getElementById('ext-btn').hidden`), 'after a reload the restored chat has no 🧩');
ok('a chat restored on load shows the button too');

if (problems.length) await fail('errors on the page');
console.log('\nall ok');
await done(0);
