// A chat started here, rather than reopened, must be tailed too.
//
// sync.mjs covers a session whose transcript already exists. A fresh chat has
// none: the file appears a moment after the session announces itself, and a
// tail that looked once and gave up follows nothing for the rest of the chat.
// Nothing shows that directly -- what shows is a background agent whose row
// runs forever, because its completion is announced into that file and nowhere
// else.
import { startHost, scratchProject } from './host.mjs';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const projectDir = scratchProject('tail');
const sessionsDir = join(homedir(), '.claude', 'projects', projectDir.replace(/[^a-zA-Z0-9-]/g, '-'));
const host = await startHost({ projects: [projectDir] });
const ws = host.connect();
const marker = `чужая запись ${Date.now()}`;
let chatId = null;

const newestTranscript = () => {
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(sessionsDir, f));
  if (!files.length) throw new Error('the session wrote no transcript at all');
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
};

const foreign = () =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: marker },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isSidechain: false,
  }) + '\n';

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the foreign entry never reached the feed: a fresh chat is not tailed')), 60_000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'create_chat', projectPath: projectDir, model: 'haiku' })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'chat_created') {
      chatId = m.chatId;
      ws.send(JSON.stringify({ type: 'send', chatId, content: 'Ответь ровно одним словом: ок' }));
    }
    if (m.type === 'chat_message' && m.chatId === chatId) {
      if (m.msg.type === 'result') {
        // the transcript exists by now; write into it as another editor would
        setTimeout(() => appendFileSync(newestTranscript(), foreign()), 500);
      }
      if (JSON.stringify(m.msg).includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
}).catch((err) => {
  console.log(`FAIL: ${err.message}`);
  host.stop();
  process.exit(1);
});

console.log('a chat started here is tailed like any other');
host.stop();
process.exit(0);
