// Transcript sync e2e: open a chat over a synthetic session file, then append
// a "foreign" entry to that file (as VS Code would) and expect the host to
// broadcast it into the feed without any SDK involvement.
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const projectDir = mkdtempSync(join(tmpdir(), 'remaude-sync-'));
const sessionId = randomUUID();
const slug = projectDir.replace(/[^a-zA-Z0-9-]/g, '-');
const sessionsDir = join(homedir(), '.claude', 'projects', slug);
mkdirSync(sessionsDir, { recursive: true });
const file = join(sessionsDir, `${sessionId}.jsonl`);

const entry = (type, content) =>
  JSON.stringify({
    type,
    message: { role: type, content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isSidechain: false,
  }) + '\n';

writeFileSync(file, entry('user', 'старое сообщение') + entry('assistant', [{ type: 'text', text: 'старый ответ' }]));

const ws = new WebSocket('ws://127.0.0.1:7699/ws');
const marker = `чужая запись ${Date.now()}`;
let chatId;

const finished = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout: foreign entry never arrived')), 25_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
    ws.send(JSON.stringify({ type: 'open_session', projectPath: projectDir, sessionId }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'chat_created') {
      chatId = m.chatId;
      console.log('[opened]', chatId.slice(0, 8));
      // подождём, пока tail возьмёт offset, и допишем «чужое»
      setTimeout(() => appendFileSync(file, entry('user', marker)), 1000);
    }
    if (m.type === 'chat_message' && m.chatId === chatId && JSON.stringify(m.msg).includes(marker)) {
      console.log('[foreign entry arrived in feed]');
      resolve();
    }
    if (m.type === 'error') console.log('[err]', m.message);
  });
});

await finished;
// прибираем за собой: закрываем чат и проект
ws.send(JSON.stringify({ type: 'hide_chat', chatId }));
ws.send(JSON.stringify({ type: 'close_project', path: projectDir }));
setTimeout(() => {
  ws.close();
  console.log('SYNC OK');
  process.exit(0);
}, 500);
