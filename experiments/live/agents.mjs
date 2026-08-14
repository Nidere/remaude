// Subagent tracking e2e: ask the chat to run one trivial agent and watch the
// host report it as running and then finished over the WS protocol.
import { startHost, scratchProject } from './host.mjs';
import { randomUUID } from 'node:crypto';

const projectDir = scratchProject('agents');
const host = await startHost();
const ws = host.connect();
let chatId;
const seen = [];

const finished = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout: no finished agent reported')), 180_000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'add_project', path: projectDir }));
    ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, permissionMode: 'bypassPermissions' }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'chat_created' && !chatId) {
      chatId = m.chatId;
      ws.send(
        JSON.stringify({
          type: 'send',
          chatId,
          localId: randomUUID(),
          content:
            'Запусти ровно одного сабагента (Agent tool, general-purpose) с задачей: ответить словом "готово". Больше ничего не делай.',
        })
      );
    }
    if (m.type === 'agents' && m.chatId === chatId) {
      for (const a of m.agents) console.log(`[agent] ${a.status} · ${a.label} · ${a.type ?? '-'}`);
      seen.push(...m.agents.map((a) => a.status));
      if (m.agents.some((a) => a.status !== 'running')) resolve();
    }
    if (m.type === 'error') console.log('[err]', m.message);
  });
});

await finished;
console.log(`statuses seen: ${[...new Set(seen)].join(', ')}`);
host.stop();
console.log(seen.includes('running') ? 'AGENTS OK' : 'AGENTS: running state never seen');
process.exit(seen.includes('running') ? 0 : 1);
