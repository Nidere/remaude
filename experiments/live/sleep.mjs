// A chat costs a process only while it is being used.
//
// Thirty chats in the sidebar were thirty `claude` processes and eleven
// gigabytes, held from the moment the host started, whether or not anyone had
// said a word that day. Three things have to be true instead: an idle chat lets
// its session go, writing to it brings the session back, and a host that starts
// with a full sidebar starts no sessions at all.
import { startHost, scratchProject } from './host.mjs';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDLE_MS = 4000;
const projectDir = scratchProject('sleep');
const env = { REMAUDE_IDLE_SLEEP_MS: String(IDLE_MS) };

/** How many sessions this host is holding right now. */
function sessions(hostPid) {
  if (process.platform !== 'win32') return null; // counted only where the probes run
  const where = `Where-Object { $_.Name -eq 'claude.exe' -and $_.ParentProcessId -eq ${hostPid} }`;
  const out = execSync(`powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | ${where}).Count"`, {
    encoding: 'utf8',
  });
  return Number(out.trim());
}

const fail = (why, host) => {
  console.log(`FAIL: ${why}`);
  host?.stop();
  process.exit(1);
};

/** Wait for the chat to be reported in a given state, or give up. */
function waitForStatus(ws, chatId, want, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the chat never went to "${want}"`)), ms);
    const onMessage = (raw) => {
      const m = JSON.parse(raw);
      const chats = m.type === 'state' ? m.projects.flatMap((p) => p.chats) : [];
      const seen =
        (m.type === 'chat_status' && m.chatId === chatId && m.status === want) ||
        chats.some((c) => c.id === chatId && c.status === want);
      if (!seen) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve();
    };
    ws.on('message', onMessage);
  });
}

function answered(ws, chatId, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the chat never answered')), ms);
    const onMessage = (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== 'chat_message' || m.chatId !== chatId || m.msg.type !== 'result') return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve();
    };
    ws.on('message', onMessage);
  });
}

// ---------- a chat that has been left alone lets its session go ----------

const host = await startHost({ projects: [projectDir], env });
const ws = host.connect();
await new Promise((r) => ws.on('open', r));

const chatId = await new Promise((resolve) => {
  ws.on('message', function first(raw) {
    const m = JSON.parse(raw);
    if (m.type !== 'chat_created') return;
    ws.off('message', first);
    resolve(m.chatId);
  });
  ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' }));
});

ws.send(JSON.stringify({ type: 'send', chatId, content: 'Ответь ровно одним словом: ок' }));
await answered(ws, chatId, 90_000).catch((e) => fail(e.message, host));
const busy = sessions(host.child.pid);
console.log(`  after a turn:      ${busy} session(s)`);
if (busy !== null && busy < 1) fail('the chat answered without a session, which cannot be', host);

await waitForStatus(ws, chatId, 'sleeping', IDLE_MS * 6).catch((e) => fail(e.message, host));
await new Promise((r) => setTimeout(r, 1500)); // the process leaves once its stdin closes
const asleep = sessions(host.child.pid);
console.log(`  after an idle hour: ${asleep} session(s)`);
if (asleep !== null && asleep !== 0) fail(`the chat slept but ${asleep} session(s) stayed`, host);

// ---------- and comes back when written to ----------

ws.send(JSON.stringify({ type: 'send', chatId, content: 'Ответь ровно одним словом: два' }));
await answered(ws, chatId, 90_000).catch((e) => fail('a sleeping chat did not wake to a message', host));
console.log(`  woken by a message: ${sessions(host.child.pid)} session(s)`);

// ---------- a session killed from outside is not the end of the chat ----------

if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.ParentProcessId -eq ${host.child.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`
  );
  console.log('  killed the session from outside');
  await new Promise((r) => setTimeout(r, 1500));
  ws.send(JSON.stringify({ type: 'send', chatId, content: 'Ответь ровно одним словом: три' }));
  await answered(ws, chatId, 90_000).catch(() => fail('a chat whose session was killed could not be written to', host));
  console.log(`  written to again:   ${sessions(host.child.pid)} session(s)`);
}

// ---------- a host that starts with a full sidebar starts no sessions ----------

// keep the config: stopping a host takes its temp folder with it
const kept = join(mkdtempSync(join(tmpdir(), 'remaude-kept-')), 'host.json');
copyFileSync(host.config, kept);
host.stop();
await new Promise((r) => setTimeout(r, 2000));
const again = await startHost({ configPath: kept, port: host.port + 1, env: { REMAUDE_IDLE_SLEEP_MS: '3600000' } });
const ws2 = again.connect();
await new Promise((r) => ws2.on('open', r));
const restored = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the restarted host never described itself')), 20_000);
  ws2.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'state') return;
    const chats = m.projects.flatMap((p) => p.chats);
    if (!chats.length) return;
    clearTimeout(timer);
    resolve(chats);
  });
}).catch((e) => fail(e.message, again));

await new Promise((r) => setTimeout(r, 3000)); // long enough for sessions to have started, had they been going to
const atRest = sessions(again.child.pid);
console.log(`  reopened ${restored.length} chat(s) on startup: ${atRest} session(s), status ${restored[0].status}`);
if (restored[0].status !== 'sleeping') fail(`a reopened chat came back as "${restored[0].status}"`, again);
if (atRest !== null && atRest !== 0) fail(`${atRest} session(s) started for chats nobody had opened`, again);

again.stop();
console.log('\na chat holds a session only while it is being used');
process.exit(0);
