// Why the header said "ctx —", and whether it still does.
//
// Part one times getContextUsage() at the moments the host asks for it. Part two
// watches the header itself: it must arrive at once and the count must follow.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, scratchProject } from './host.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'remaude-ctx-'));

/** The host waits 20s. Here we wait as long, to tell slow from never. */
async function probe(q, when, ms = 20000) {
  const t = Date.now();
  const timeout = Symbol('timeout');
  try {
    const u = await Promise.race([q.getContextUsage(), new Promise((r) => setTimeout(() => r(timeout), ms))]);
    const took = Date.now() - t;
    if (u === timeout) console.log(`  ${when.padEnd(28)} NO ANSWER in ${ms}ms`);
    else if (!u || u.percentage == null) console.log(`  ${when.padEnd(28)} empty (${took}ms): ${JSON.stringify(u)}`);
    else console.log(`  ${when.padEnd(28)} ${Math.round(u.percentage)}% ${u.totalTokens}/${u.maxTokens} (${took}ms)`);
  } catch (err) {
    console.log(`  ${when.padEnd(28)} THREW after ${Date.now() - t}ms: ${err.message}`);
  }
}

async function session({ resume, label, say }) {
  console.log(`\n--- ${label} ---`);
  let finish;
  const done = new Promise((r) => (finish = r));

  async function* input() {
    if (say) yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: say } };
    await done;
  }

  const q = query({
    prompt: input(),
    options: { cwd, resume, model: 'haiku', includePartialMessages: true, allowedTools: [] },
  });

  // the header is drawn the moment a chat is opened — nothing has happened yet
  probe(q, 'at once, before anything', 30000);

  let sessionId = null;
  let probedInTurn = false;
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id;
    if (msg.type === 'stream_event' && !probedInTurn) {
      probedInTurn = true;
      probe(q, 'mid-turn (streaming)');
    }
    if (msg.type === 'result') {
      await probe(q, 'right after result');
      finish();
    }
  }
  return sessionId;
}

console.log('=== how long the SDK takes to count the context ===');
const id = await session({ label: 'fresh session', say: 'Ответь ровно одним словом: ок' });
await session({ resume: id, label: 'resumed session', say: 'Ответь ровно одним словом: два' });

// ---------- part two: what the header does with that ----------

console.log('\n=== the header on a host of our own ===');
const projectDir = scratchProject('ctx');
const host = await startHost({ projects: [projectDir] });
const ws = host.connect();
let chatId = null;
let opened = 0;
const metas = [];

const fail = (why) => {
  console.log(`FAIL: ${why}`);
  host.stop();
  process.exit(1);
};

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout 90s')), 90_000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'chat_created') {
      chatId = msg.chatId;
      opened = Date.now();
      ws.send(JSON.stringify({ type: 'focus', chatId })); // what a browser does when you open a chat
    }
    if (msg.type === 'chat_meta' && msg.chatId === chatId) {
      metas.push({ at: Date.now() - opened, context: msg.context, model: msg.model });
      console.log(`  chat_meta +${Date.now() - opened}ms  model=${msg.model}  ctx=${msg.context?.percentage ?? '—'}%`);
      if (msg.context) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
});

const first = metas[0];
if (first.at > 2000) fail(`the header waited ${first.at}ms instead of going out at once`);
if (!metas.some((m) => m.context)) fail('the count never arrived');
console.log('\nthe header goes out first and the count follows it');
host.stop();
process.exit(0);
