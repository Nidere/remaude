// End-to-end test of the WS protocol: project → chat → message → permission (Write) →
// allow → check that the file was actually created → history.
import WebSocket from 'ws';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectDir = mkdtempSync(join(tmpdir(), 'remaude-e2e-'));
const ws = new WebSocket('ws://127.0.0.1:7699/ws');
let chatId = null;
let sawPermission = false;
let streamed = '';

const finished = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout 120s')), 120_000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
    ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'chat_created':
        chatId = msg.chatId;
        ws.send(
          JSON.stringify({
            type: 'send',
            chatId,
            content:
              'Создай в текущей рабочей директории файл hello.txt (относительный путь!) с одной строкой: привет remaude. Больше ничего не делай и не объясняй.',
          })
        );
        break;
      case 'permission_request':
        sawPermission = true;
        console.log(`[perm] ${msg.toolName}: ${JSON.stringify(msg.input).slice(0, 120)}`);
        ws.send(
          JSON.stringify({
            type: 'permission_response',
            requestId: msg.requestId,
            result: { behavior: 'allow', updatedInput: msg.input },
          })
        );
        break;
      case 'chat_message':
        if (msg.msg.type === 'stream_event' && msg.msg.event?.delta?.type === 'text_delta')
          streamed += msg.msg.event.delta.text;
        if (msg.msg.type === 'result') {
          console.log(`[result] ${msg.msg.subtype}`);
          ws.send(JSON.stringify({ type: 'history', chatId }));
        }
        break;
      case 'history':
        console.log(`[history] ${msg.messages.length} messages: ${msg.messages.map((m) => m.type).join(', ')}`);
        resolve();
        break;
      case 'limits':
        console.log(`[limits] 5h=${msg.limits.fiveHour?.utilization}% week=${msg.limits.sevenDay?.utilization}%`);
        break;
      case 'chat_error':
      case 'error':
        reject(new Error(msg.error ?? msg.message));
    }
  });
});

try {
  await finished;
  console.log(`[stream] ${streamed.trim().slice(0, 100) || '(empty)'}`);
  console.log(`[perm seen] ${sawPermission}`);
  console.log(`[file] ${readFileSync(join(projectDir, 'hello.txt'), 'utf-8').trim()}`);
  console.log('E2E OK');
} finally {
  ws.close();
}
