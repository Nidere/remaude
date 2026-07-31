// Сквозной тест возобновления: list_sessions видит сессию с диска,
// open_session поднимает её, history отдаёт старые сообщения из транскрипта.
import WebSocket from 'ws';

const projectDir = process.argv[2];
const expectSession = process.argv[3];
const expectText = process.argv[4] ?? '';
if (!projectDir || !expectSession) {
  console.error('usage: node test-sessions.mjs <projectDir> <sessionId> [expectText]');
  process.exit(2);
}

const ws = new WebSocket('ws://127.0.0.1:7699/ws');
let chatId;

const finished = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout')), 20_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
    ws.send(JSON.stringify({ type: 'list_sessions', projectPath: projectDir }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'sessions') {
      console.log(`[sessions] ${msg.sessions.length}: ${msg.sessions.map((s) => `${s.id.slice(0, 8)} "${(s.title ?? s.preview ?? '').slice(0, 40)}"`).join(' | ')}`);
      const target = msg.sessions.find((s) => s.id === expectSession);
      if (!target) return reject(new Error('session not listed'));
      ws.send(JSON.stringify({ type: 'open_session', projectPath: projectDir, sessionId: expectSession }));
    }
    if (msg.type === 'chat_created') {
      chatId = msg.chatId;
      ws.send(JSON.stringify({ type: 'history', chatId }));
    }
    if (msg.type === 'history') {
      const texts = msg.messages.map((m) => JSON.stringify(m.message?.content)).join(' ');
      console.log(`[history] ${msg.messages.length} messages, contains "${expectText}": ${texts.includes(expectText)}`);
      if (expectText && !texts.includes(expectText)) return reject(new Error('expected text missing'));
      resolve();
    }
    if (msg.type === 'error') reject(new Error(msg.message));
  });
});

await finished;
ws.close();
console.log('SESSIONS OK');
