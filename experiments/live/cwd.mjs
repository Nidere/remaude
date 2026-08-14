// Check: does the cwd reach the SDK session (system:init carries the actual cwd).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat } from '../../src/host/chat.js';

const dir = mkdtempSync(join(tmpdir(), 'remaude-cwd-'));
console.log('expected cwd:', dir);

const chat = new Chat({ cwd: dir, model: 'haiku' });
chat.on('message', (msg) => {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('actual cwd:  ', msg.cwd);
    console.log(msg.cwd === dir ? 'CWD OK' : 'CWD MISMATCH');
  }
  if (msg.type === 'result') chat.close();
});
chat.send('Ответь одним словом: ок');
