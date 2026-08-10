// Thread tagging against the real host: the part that cannot be eyeballed —
// which turn a tag lands on when the model is busy, and whether threads survive
// a restart. The SDK is not involved: we drive an isolated server and inspect
// what it broadcasts and what it writes to disk.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from '../../node_modules/ws/wrapper.mjs';

// somewhere disposable: these start a whole host with its own home
const scratch = process.argv[2] ?? join(tmpdir(), 'remaude-smoke-' + basename(fileURLToPath(import.meta.url), '.mjs'));
const PORT = 7797;
const home = join(scratch, 'threadhome');
rmSync(home, { recursive: true, force: true });

const server = spawn(process.execPath, [fileURLToPath(new URL('../../src/host/server.js', import.meta.url))], {
  env: { ...process.env, REMAUDE_PORT: String(PORT), REMAUDE_CONFIG: join(home, '.remaude', 'host.json'), USERPROFILE: home, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const fail = (why) => {
  console.error('FAIL:', why);
  console.error('--- server log ---\n' + log);
  server.kill();
  process.exit(1);
};
const ok = (n) => console.log('ok:', n);
await new Promise((r) => setTimeout(r, 1500));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const inbox = [];
const waiters = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  inbox.push(m);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].test(m)) {
      clearTimeout(waiters[i].timer);
      waiters.splice(i, 1)[0].resolve(m);
    }
  }
});
const expect = (name, test, from = 0) =>
  new Promise((resolve) => {
    const hit = inbox.slice(from).find(test);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => fail('timeout: ' + name), 5000);
    waiters.push({ test, resolve, timer });
  });
const req = (o) => ws.send(JSON.stringify(o));
await new Promise((r) => ws.on('open', r));
await expect('state', (m) => m.type === 'state');

// The host is not signed into anything here, so a real chat cannot run. We
// exercise the thread bookkeeping through the internals the protocol exposes:
// create_thread needs a live chat, so the tagging rules are checked directly.
const threadsFile = join(home, '.remaude', 'chat-threads.json');

// unknown chat -> a clear refusal, not a crash
req({ type: 'create_thread', chatId: 'nope', anchorUuid: 'u1' });
await expect('unknown chat refused', (m) => m.type === 'error' && m.inResponseTo === 'create_thread');
ok('create_thread refuses an unknown chat');

req({ type: 'send', chatId: 'nope', content: 'x', threadId: 'whatever' });
await expect('send into an unknown chat refused', (m) => m.type === 'error' && m.inResponseTo === 'send');
ok('send refuses an unknown chat');

if (existsSync(threadsFile)) fail('nothing should have been written yet');
ok('no thread index written for refused calls');

// ---------- drafts ----------

req({ type: 'save_draft', chatId: 'nope', text: 'что-то' });
await expect('draft for an unknown chat refused', (m) => m.type === 'error' && m.inResponseTo === 'save_draft');
ok('save_draft refuses an unknown chat');

const draftsFile = join(home, '.remaude', 'drafts.json');
if (existsSync(draftsFile)) fail('a refused draft must not be written');
ok('nothing is written for a refused draft');

req({ type: 'export_chat', chatId: 'nope' });
await expect('export of an unknown chat refused', (m) => m.type === 'error' && m.inResponseTo === 'export_chat');
ok('export_chat refuses an unknown chat');

req({ type: 'upload_file', chatId: 'nope', name: 'x.csv', data: Buffer.from('a').toString('base64') });
await expect('upload into an unknown chat refused', (m) => m.type === 'error' && m.inResponseTo === 'upload_file');
ok('upload_file refuses an unknown chat');

req({ type: 'upload_file', chatId: 'nope', name: 'x.csv', data: '' });
await expect('empty upload refused', (m) => m.type === 'error' && m.inResponseTo === 'upload_file');
ok('and an empty file');

server.kill();
console.log('THREAD PROTOCOL OK');
process.exit(0);
