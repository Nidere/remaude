// День 1, открытый вопрос №2: данные для виджета лимитов.
// Проверяем query.accountInfo() и экспериментальный usage-метод (структура /usage),
// плюс ловим rate_limit_event в стриме.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let finish;
const done = new Promise((r) => (finish = r));

async function* input() {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'Ответь ровно одним словом: ок' },
  };
  await done; // держим сессию живой, пока не опросим usage
}

const q = query({
  prompt: input(),
  options: {
    cwd: mkdtempSync(join(tmpdir(), 'remaude-test-')),
    model: 'haiku',
    maxTurns: 1,
    allowedTools: [],
  },
});

for await (const msg of q) {
  if (msg.type === 'rate_limit_event') {
    console.log('RATE_LIMIT_EVENT:', JSON.stringify(msg.rate_limit_info, null, 2));
  }
  if (msg.type === 'result') {
    console.log('RESULT:', msg.subtype);

    console.log('\n--- accountInfo() ---');
    try {
      console.log(JSON.stringify(await q.accountInfo(), null, 2));
    } catch (e) {
      console.log('FAILED:', e.message);
    }

    console.log('\n--- usage (experimental) ---');
    try {
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      console.log(JSON.stringify(usage, null, 2));
    } catch (e) {
      console.log('FAILED:', e.message);
    }

    finish();
    break;
  }
}
