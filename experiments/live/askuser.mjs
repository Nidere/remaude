// What happens in an SDK session (= in remaude) if the model invokes AskUserQuestion.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat } from '../../src/host/chat.js';

const chat = new Chat({
  cwd: mkdtempSync(join(tmpdir(), 'remaude-ask-')),
  model: 'haiku',
  permissionMode: 'bypassPermissions',
  onPermissionRequest: async ({ toolName }) => {
    console.log(`[canUseTool] ${toolName}`);
    return { behavior: 'allow', updatedInput: {} };
  },
});

const timer = setTimeout(() => {
  console.log('TIMEOUT 60s — the tool hung without a response');
  chat.close();
  process.exit(0);
}, 60_000);

chat.on('message', (msg) => {
  if (msg.type === 'assistant') {
    for (const b of msg.message.content ?? []) {
      if (b.type === 'tool_use') console.log(`[tool_use] ${b.name}: ${JSON.stringify(b.input).slice(0, 120)}`);
      if (b.type === 'text' && b.text.trim()) console.log(`[text] ${b.text.slice(0, 200)}`);
    }
  }
  if (msg.type === 'user') {
    for (const b of msg.message.content ?? []) {
      if (b.type === 'tool_result')
        console.log(`[tool_result] error=${b.is_error ?? false}: ${JSON.stringify(b.content).slice(0, 250)}`);
    }
  }
  if (msg.type === 'result') {
    console.log(`[result] ${msg.subtype}`);
    clearTimeout(timer);
    chat.close();
    process.exit(0);
  }
});

chat.send('Вызови инструмент AskUserQuestion с вопросом "какой цвет лучше?" и вариантами "красный"/"синий". Именно инструмент, это тест.');
