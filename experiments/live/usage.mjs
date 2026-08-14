// Day 1, open question #2: data for the limits widget.
// We check query.accountInfo() and the experimental usage method (the /usage structure),
// plus we catch rate_limit_event in the stream.
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
  await done; // keep the session alive until we have queried usage
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
