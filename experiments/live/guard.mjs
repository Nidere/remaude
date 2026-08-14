// Security guards, checked against a throwaway host on its own port/config:
//   1. a browser origin that is not ours cannot open the local socket
//   2. a crafted session id cannot walk out of its project folder
//   3. /connect does not re-pair on a bare browser GET
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const PORT = 7791;
const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dir = mkdtempSync(join(tmpdir(), 'remaude-guard-'));
const projectDir = mkdtempSync(join(tmpdir(), 'remaude-guardproj-'));
const config = join(dir, 'host.json');
writeFileSync(config, JSON.stringify({ projects: [projectDir], openChats: [] }));

// a transcript in a *different* project, the thing traversal would reach
const secretProject = mkdtempSync(join(tmpdir(), 'remaude-secret-'));
const secretId = randomUUID();
const secretDir = join(homedir(), '.claude', 'projects', secretProject.replace(/[^a-zA-Z0-9-]/g, '-'));
mkdirSync(secretDir, { recursive: true });
writeFileSync(
  join(secretDir, `${secretId}.jsonl`),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'TOP SECRET' }, uuid: randomUUID() }) + '\n'
);

const child = spawn(process.execPath, [join(repo, 'src', 'host', 'server.js')], {
  cwd: repo,
  env: { ...process.env, REMAUDE_PORT: String(PORT), REMAUDE_CONFIG: config },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. foreign origin on the local socket
const foreign = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'https://evil.example' } });
  ws.on('open', () => {
    ws.close();
    resolve('accepted');
  });
  ws.on('error', () => resolve('rejected'));
  setTimeout(() => resolve('timeout'), 4000);
});
check('foreign origin rejected on /ws', foreign === 'rejected', foreign);

// 2. traversal through a session id
const traversal = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let chatId = null;
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        type: 'open_session',
        projectPath: projectDir,
        sessionId: `../${secretProject.replace(/[^a-zA-Z0-9-]/g, '-')}/${secretId}`,
      })
    )
  );
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'error') resolve(`refused (${m.message})`);
    if (m.type === 'chat_created') {
      chatId = m.chatId;
      ws.send(JSON.stringify({ type: 'history', chatId }));
    }
    if (m.type === 'history') resolve(JSON.stringify(m.messages).includes('TOP SECRET') ? 'LEAKED' : 'empty');
  });
  setTimeout(() => resolve('no answer'), 6000);
});
check('session id traversal blocked', !traversal.includes('LEAKED'), traversal);

// 3. /connect must not act on a plain browser GET
const res = await fetch(`http://127.0.0.1:${PORT}/connect?token=x&relay=https://evil.example`, {
  headers: { accept: 'text/html' },
});
const body = await res.text();
const configNow = existsSync(config) ? readFileSync(config, 'utf-8') : '';
check(
  '/connect asks before pairing',
  body.includes('connect this computer') && !configNow.includes('evil.example'),
  `status ${res.status}`
);

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `${failed.length} GUARD(S) FAILED` : 'GUARDS OK');
process.exitCode = failed.length ? 1 : 0;
child.kill(); // let node unwind on its own; killing then exiting trips a libuv assert
