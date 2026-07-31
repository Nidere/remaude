// Day 1, open question #1: does the SDK accept base64 image blocks in an incoming
// SDKUserMessage. We send a picture (red top, blue bottom) and ask it to name the colors.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestPng } from './png.mjs';

const png = makeTestPng();
console.log(`PNG: ${png.length} bytes`);

async function* input() {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'На картинке две горизонтальные цветные полосы. Назови цвет верхней и цвет нижней, ровно два слова через запятую, ничего больше.',
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
      ],
    },
  };
}

const q = query({
  prompt: input(),
  options: {
    cwd: mkdtempSync(join(tmpdir(), 'remaude-test-')),
    model: 'haiku',
    maxTurns: 1,
    allowedTools: [],
    systemPrompt: 'Отвечай максимально коротко.',
  },
});

for await (const msg of q) {
  if (msg.type === 'assistant') {
    const text = msg.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    console.log('ASSISTANT:', text);
  }
  if (msg.type === 'result') {
    console.log('RESULT:', msg.subtype, '| cost $' + (msg.total_cost_usd ?? 0).toFixed(4));
    break;
  }
}
