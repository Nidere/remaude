// Repro probe for duplicated user bubbles: send one message, count how many
// user-type broadcasts with that text come back (echo, tail, anything else).
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const projectDir = mkdtempSync(join(tmpdir(), 'remaude-dupe-'));
const marker = `тест дедупа ${Date.now()}`;
const ws = new WebSocket('ws://127.0.0.1:7699/ws');
let chatId;
const hits = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
  ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'chat_created' && !chatId) {
    chatId = m.chatId;
    ws.send(JSON.stringify({ type: 'send', chatId, content: marker + ' — ответь словом ок', localId: randomUUID() }));
  }
  if (m.type === 'chat_message' && m.chatId === chatId && m.msg.type === 'user' && JSON.stringify(m.msg).includes(marker)) {
    hits.push({ author: m.msg.author ?? null, localId: m.msg.localId ?? null, uuid: m.msg.uuid ?? null });
    console.log(`[user-broadcast #${hits.length}]`, JSON.stringify(hits.at(-1)));
  }
});

// ждём достаточно, чтобы и результат пришёл, и tail успел отработать пару циклов
setTimeout(() => {
  console.log(`total user broadcasts: ${hits.length} (1 = ок, 2+ = дубль)`);
  ws.send(JSON.stringify({ type: 'hide_chat', chatId }));
  ws.send(JSON.stringify({ type: 'close_project', path: projectDir }));
  setTimeout(() => process.exit(hits.length === 1 ? 0 : 1), 500);
}, 20000);
