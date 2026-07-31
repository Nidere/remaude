// Smoke test of the skeleton: project → chat → streaming deltas to the console → limits → second turn.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgent } from '../src/host/agent.js';

const agent = new HostAgent({
  onPermissionRequest: async ({ toolName, input }) => {
    console.log(`\n[permission] ${toolName} → auto-allow`);
    return { behavior: 'allow', updatedInput: input };
  },
});

agent.on('chat_status', ({ status }) => console.log(`\n[status] ${status}`));

const chat = agent.createChat(mkdtempSync(join(tmpdir(), 'remaude-smoke-')), { model: 'haiku' });

let resolveTurn;
chat.on('message', (msg) => {
  if (msg.type === 'stream_event' && msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
    process.stdout.write(msg.event.delta.text);
  }
  if (msg.type === 'result') resolveTurn?.();
});

async function turn(text) {
  const done = new Promise((r) => (resolveTurn = r));
  console.log(`\n>>> ${text}`);
  chat.send(text);
  await done;
}

await turn('Ответь одним предложением: что такое WebSocket?');
console.log('\n[limits]', JSON.stringify(await agent.limits()));
await turn('А теперь то же самое, но как хокку.');
console.log(`\n[session] ${chat.sessionId}`);

agent.closeAll();
